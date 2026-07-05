// lib/commands/suggest.js — LLM 回复建议（可自动发布，含反检测引擎）
//
// v4 改造：
// - 人格化回复（7 种人格自动轮换）
// - 随机延迟（45-180s 发布间隔 + 疲劳累加）
// - 模拟浏览穿插（每发 ~5 条穿插一次 browse）
// - 断路器改为 events 表窗口统计（避免累计 hit_count 误触发）

const fs = require('fs');
const path = require('path');
const { getFlag } = require('./helpers');
const corpus = require('../memory/corpus');
const failures = require('../memory/failures');
const users = require('../memory/users');
const commentsRepo = require('../memory/comments');
const { humanDelay, maybeDelay, jitter } = require('../jitter');
const { pickPersona } = require('../personas');

const BASE_POST_INTERVAL_MS = 60000; // 基础 60s，实际使用 ±30% 抖动

const CORPUS_FEWSHOT_LIMIT = 20;
const FAILURE_TOP_LIMIT = 10;
const AVOID_LIMIT = 30;

/**
 * LLM 回复建议
 * @param {object} ctx - { bridge, audit, config, cmdAnalyze, cmdPost, cmdSearch, cmdLike, cmdBrowse }
 * @param {string[]} args - [aweme_id, --auto, --min-priority N, --fast, --force]
 */
async function cmdSuggest(ctx, args) {
  const awemeId = args[0];
  if (!awemeId) throw new Error('用法: node cli.js suggest <aweme_id> [--auto] [--min-priority N] [--fast]');
  const auto = args.includes('--auto');
  const force = args.includes('--force');
  const fast = args.includes('--fast');
  const minPriority = getFlag(args, '--min-priority', 0);
  const userInterval = getFlag(args, '--interval', null);
  const postInterval = userInterval != null ? userInterval : jitter(BASE_POST_INTERVAL_MS, 0.30);

  const llm = require('../llm');
  ctx.audit.startOperation('suggest', {
    aweme_id: awemeId, auto, force, fast, min_priority: minPriority, post_interval: Math.round(postInterval),
  });

  // 先分析
  console.error('正在分析评论...');
  let analysis;
  try {
    analysis = await ctx.cmdAnalyze([awemeId, ...(force ? ['--force'] : [])]);
  } catch (e) {
    ctx.audit.endOperation('error', {}, null, e.message);
    throw e;
  }

  if (!analysis || analysis.length === 0) {
    console.error('没有需要回复的评论。');
    ctx.audit.endOperation('success', { suggested: 0 });
    return [];
  }

  // 模拟阅读时间（概率 50%）
  if (!fast) await maybeDelay(0.5, 2000, 6000);

  // 筛选需回复的（cid 一生一次：默认跳过已回复，--force 覆盖）
  const toReply = analysis.filter(a =>
    a.priority >= minPriority
    && a.sentiment !== 'negative'
    && (force || !commentsRepo.get(String(a.cid))?.replied)
  );

  // 给每条评论挂上用户画像标签
  for (const c of toReply) {
    const uid = c.uid || c.user?.uid;
    if (uid) {
      const u = users.get(String(uid));
      if (u && Array.isArray(u.tags) && u.tags.length) c.userTags = u.tags;
    }
  }

  // 读取策略
  let strategy = '';
  try { strategy = fs.readFileSync(path.join(process.cwd(), 'reply-strategy.md'), 'utf8'); } catch (e) { /* */ }

  // ── v3 P3 上下文注入 ──
  const histCorpus = corpus.recent({ limit: CORPUS_FEWSHOT_LIMIT, outcomes: ['published'] });
  const histFailures = failures.top(FAILURE_TOP_LIMIT);
  const avoidTexts = histCorpus.slice(0, AVOID_LIMIT).map(c => c.replyText).filter(Boolean);

  console.error(`[suggest] 注入历史: corpus=${histCorpus.length} failures=${histFailures.length} avoid=${avoidTexts.length}`);

  const client = new llm.LLMClient(ctx.config.llm || {});
  const llmContext = {
    corpus: histCorpus.map(c => ({ srcText: c.srcText, replyText: c.replyText })),
    failures: histFailures,
    avoid: avoidTexts,
  };

  // 随机选择人格
  const persona = pickPersona();
  if (process.env.DOUYIN_DEBUG) {
    console.error(`[suggest] 使用人格: ${persona.name} (temp=${persona.temperature.toFixed(2)})`);
  }

  let suggestions = await client.suggestReplies(toReply, strategy, '', llmContext, persona);

  // 模拟思考时间（概率 30%）
  if (!fast && suggestions.length > 0) await maybeDelay(0.3, 3000, 8000);

  // ── 去重护栏：reply_hash 命中过 → 让 LLM 重写一次（强制切换人格）──
  const dupCids = new Set();
  for (const s of suggestions) {
    if (!s.reply) continue;
    if (corpus.findByText(s.reply)) dupCids.add(s.cid);
  }
  if (dupCids.size > 0) {
    console.error(`[suggest] ${dupCids.size} 条命中已发过的回复，调用 LLM 重写...`);
    for (const s of suggestions) {
      if (!dupCids.has(s.cid)) continue;
      try {
        const newReply = await client.rewriteReply(
          (toReply.find(t => t.cid === s.cid) || {}).text || '',
          s.reply,
          strategy,
          '',
          persona,
        );
        if (newReply && !corpus.findByText(newReply)) {
          s.reply = newReply;
          s.rewritten = true;
        } else {
          s._duplicate = true;
        }
      } catch (e) {
        if (process.env.DOUYIN_DEBUG) console.warn('[suggest] rewrite failed:', e.message);
        s._duplicate = true;
      }
    }
  }

  const results = [];
  const autoList = suggestions.slice(0, 30);
  let postedCount = 0;

  // 风控断路器：10 分钟内 post 失败 ≥3 次 → 暂停自动发布（用 events 表窗口统计）
  if (auto) {
    try {
      const { getDb } = require('../memory/db');
      const db = getDb();
      const windowStart = Date.now() - 600000;
      const failCount = db.prepare(`
        SELECT count(*) AS n FROM events
        WHERE platform = 'douyin' AND command = 'post' AND status = 'error' AND ts >= ?
      `).get(windowStart).n;
      if (failCount >= 3) {
        console.error(`[suggest] ⚠️ 风控断路器触发：10 分钟内 post 失败 ${failCount} 次，暂停自动发布。请检查后手动重试。`);
        ctx.audit.endOperation('success', {
          suggested: suggestions.length, posted: 0, circuit_breaker: `post_fail_${failCount}`,
        }, { result: suggestions.map(s => ({ ...s, skipped_circuit_breaker: true })) });
        return suggestions.map(s => ({ ...s, skipped_circuit_breaker: true }));
      }
    } catch (e) {
      if (process.env.DOUYIN_DEBUG) console.warn('[suggest] 断路器查询失败:', e.message);
    }
  }

  for (let i = 0; i < autoList.length; i++) {
    const s = autoList[i];
    if (auto && s.reply && !s._duplicate) {
      // 二次护栏：仍然命中已发过，跳过
      if (corpus.findByText(s.reply)) {
        results.push({ ...s, posted: false, error: '命中已发回复，跳过', skipped: true });
        console.error(`✗ 跳过（已发过）: ${s.reply.slice(0, 30)}...`);
        continue;
      }
      // 非首条发布前等待间隔（带疲劳累加和抖动）
      if (postedCount > 0) {
        let nextDelay = postInterval;
        if (!fast) {
          const fatigue = 1 + (Math.random() * 0.15 * postedCount);
          nextDelay = postInterval * fatigue;
          nextDelay = jitter(nextDelay, 0.20);
        }
        console.error(`⏳ 等待 ${Math.round(nextDelay / 1000)}s 后发布下一条... (${postedCount + 1}/${autoList.length})`);
        await new Promise(r => setTimeout(r, nextDelay));
      }
      try {
        const postResult = await ctx.cmdPost([s.aweme_id || awemeId, s.reply, '--reply-to', String(s.cid)]);
        results.push({ ...s, posted: true, post_cid: postResult.cid });
        postedCount++;
        console.error(`✓ 已发布 ${postedCount}/${autoList.length}: ${s.reply.slice(0, 30)}...`);
        // 穿插浏览行为
        await maybeInterleaveBrowse(ctx, postedCount, 5, fast);
      } catch (e) {
        results.push({ ...s, posted: false, error: e.message });
        console.error(`✗ 发布失败: ${e.message}`);
      }
    } else {
      results.push(s);
    }
  }

  ctx.audit.endOperation('success', {
    suggested: results.length,
    posted: auto ? results.filter(r => r.posted).length : 0,
    rewritten: results.filter(r => r.rewritten).length,
    skipped_dup: results.filter(r => r.skipped).length,
  }, { result: results });
  return results;
}

/**
 * 在自动发布工作流中穿插浏览行为
 * @param {object} ctx
 * @param {number} postedCount
 * @param {number} ratio
 * @param {boolean} fast
 */
async function maybeInterleaveBrowse(ctx, postedCount, ratio = 5, fast = false) {
  if (fast) return false;
  if (postedCount > 0 && postedCount % ratio === 0 && Math.random() < 0.6) {
    console.error(`[browse] 已发 ${postedCount} 条，穿插一次浏览...`);
    try {
      const browse = require('./browse');
      await browse(ctx, ['--max-notes', '2', '--like-chance', '0.2']);
      return true;
    } catch (e) {
      if (process.env.DOUYIN_DEBUG) console.warn('[browse] interleave browse failed:', e.message);
    }
  }
  return false;
}

module.exports = cmdSuggest;
