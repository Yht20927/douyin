// lib/commands/suggest.js — LLM 回复建议（可自动发布）
//
// v3 P3：
// - prompt 注入 ① 最近 N 条 reply_corpus（few-shot）② failures.top 10（避雷）③ users.tags 个性化片段
// - 发布前去重护栏：reply_hash 命中已发过 → 让 LLM 重写一次（最多 1 轮）

const fs = require('fs');
const path = require('path');
const { getFlag } = require('./helpers');
const corpus = require('../memory/corpus');
const failures = require('../memory/failures');
const users = require('../memory/users');
const commentsRepo = require('../memory/comments');

const POST_INTERVAL_MS = 60000; // 每条评论间隔 60 秒，防止风控

const CORPUS_FEWSHOT_LIMIT = 20;
const FAILURE_TOP_LIMIT = 10;
const AVOID_LIMIT = 30; // 最近 N 条已发回复，强制不复用

/**
 * LLM 回复建议
 * @param {object} ctx - { bridge, audit, config, cmdAnalyze, cmdPost }
 * @param {string[]} args - [aweme_id, --auto, --min-priority N]
 */
async function cmdSuggest(ctx, args) {
  const awemeId = args[0];
  if (!awemeId) throw new Error('用法: node cli.js suggest <aweme_id> [--auto] [--min-priority N]');
  const auto = args.includes('--auto');
  const force = args.includes('--force');
  const minPriority = getFlag(args, '--min-priority', 0);

  const llm = require('../llm');
  ctx.audit.startOperation('suggest', { aweme_id: awemeId, auto, force, min_priority: minPriority });

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

  // 筛选需回复的（cid 一生一次：默认跳过已回复，--force 覆盖）
  const toReply = analysis.filter(a =>
    a.priority >= minPriority
    && a.sentiment !== 'negative'
    && (force || !commentsRepo.get(String(a.cid))?.replied)
  );

  // 给每条评论挂上用户画像标签（v3 P2 实体表的产物）
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

  let suggestions = await client.suggestReplies(toReply, strategy, '', llmContext);

  // ── 去重护栏：reply_hash 命中过 → 让 LLM 重写一次 ──
  const dupCids = new Set();
  for (const s of suggestions) {
    if (!s.reply) continue;
    if (corpus.findByText(s.reply)) dupCids.add(s.cid);
  }
  if (dupCids.size > 0) {
    console.error(`[suggest] ${dupCids.size} 条命中已发过的回复，调用 LLM 重写...`);
    const dupBatch = toReply.filter(c => dupCids.has(c.cid));
    // 把命中的旧回复也加到 avoid 里，避免再次撞车
    const extraAvoid = suggestions
      .filter(s => dupCids.has(s.cid))
      .map(s => s.reply);
    const rewriteContext = {
      ...llmContext,
      avoid: [...new Set([...avoidTexts, ...extraAvoid])].slice(0, AVOID_LIMIT + extraAvoid.length),
    };
    const rewritten = await client.suggestReplies(dupBatch, strategy, '', rewriteContext);
    const rewriteByCid = new Map(rewritten.map(r => [r.cid, r.reply]));
    suggestions = suggestions.map(s => {
      if (dupCids.has(s.cid) && rewriteByCid.has(s.cid)) {
        return { ...s, reply: rewriteByCid.get(s.cid), rewritten: true };
      }
      return s;
    });
  }

  const results = [];
  const autoList = suggestions.slice(0, 30);
  let postedCount = 0;

  // 风控断路器：10 分钟内有同类失败 ≥3 次 → 暂停自动发布（防封号）
  if (auto && typeof failures.recentWithin === 'function') {
    const recent = failures.recentWithin(600000);
    const hotRisk = recent.find(r => r.hitCount >= 3);
    if (hotRisk) {
      console.error(`[suggest] ⚠️ 风控断路器触发：10 分钟内「${hotRisk.signature}」失败 ${hotRisk.hitCount} 次，暂停自动发布。请检查后手动重试。`);
      ctx.audit.endOperation('success', {
        suggested: suggestions.length, posted: 0, circuit_breaker: hotRisk.signature,
      }, { result: suggestions.map(s => ({ ...s, skipped_circuit_breaker: true })) });
      return suggestions.map(s => ({ ...s, skipped_circuit_breaker: true }));
    }
  }

  for (let i = 0; i < autoList.length; i++) {
    const s = autoList[i];
    if (auto && s.reply) {
      // 二次护栏：仍然命中已发过，跳过（避免无限改写消耗 token）
      if (corpus.findByText(s.reply)) {
        results.push({ ...s, posted: false, error: '命中已发回复，跳过', skipped: true });
        console.error(`✗ 跳过（已发过）: ${s.reply.slice(0, 30)}...`);
        continue;
      }
      // 非首条发布前等待间隔
      if (postedCount > 0) {
        console.error(`⏳ 等待 ${POST_INTERVAL_MS / 1000}s 后发布下一条... (${postedCount + 1}/${autoList.length})`);
        await new Promise(r => setTimeout(r, POST_INTERVAL_MS));
      }
      try {
        const postResult = await ctx.cmdPost([s.aweme_id || awemeId, s.reply, '--reply-to', String(s.cid)]);
        results.push({ ...s, posted: true, post_cid: postResult.cid });
        postedCount++;
        console.error(`✓ 已发布 ${postedCount}/${autoList.length}: ${s.reply.slice(0, 30)}...`);
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

module.exports = cmdSuggest;
