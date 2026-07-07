// lib/commands/campaign.js — P4 推广引擎命令族
//
// node cli.js campaign <subcommand> [args]
//   create   --name "活动名" [--goal ...] [--videos v1,v2] [--daily-quota N] [--min-priority N]
//   plan <id>                       拉评论 + LLM 预生成 task（不发送）
//   run  <id> [--limit N]           前台跑 due task（自适应间隔 + 预检 + 发布）
//   pause <id> / resume <id>        状态机
//   status <id>                     活动 + 任务计数
//   list                            全部活动
//
// 设计要点：
// - plan 产 task（cid 唯一，幂等可重跑）；run 消费 task。
// - run 用 riskControl.adaptiveInterval 节奏 + preflightPublish 预检，
//   cmdPost 传 --no-throttle（节奏由 adaptive 接管，不让 enforceDelay 二次阻塞）。

const fs = require('fs');
const path = require('path');
const campaigns = require('../memory/campaigns');
const comments = require('../memory/comments');
const users = require('../memory/users');
const riskControl = require('../risk-control');
const repoInfo = require('./repo-info');
const { getFlag } = require('./helpers');

function parseCsv(s) {
  if (!s) return [];
  return String(s).split(',').map(x => x.trim()).filter(Boolean);
}

function positionalId(args) {
  const a = args.find(x => typeof x === 'string' && /^\d+$/.test(x));
  return a ? Number(a) : null;
}

async function cmdCampaign(ctx, args) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'create': return subCreate(ctx, rest);
    case 'plan':   return subPlan(ctx, rest);
    case 'run':    return subRun(ctx, rest);
    case 'pause':  return subPause(ctx, rest);
    case 'resume': return subResume(ctx, rest);
    case 'status': return subStatus(ctx, rest);
    case 'list':   return subList(ctx, rest);
    default: throw new Error(`未知子命令: ${sub}\n用法: campaign <create|plan|run|pause|resume|status|list>`);
  }
}

async function subCreate(ctx, args) {
  const name = getFlag(args, '--name', null);
  if (!name) {
    throw new Error('用法: campaign create --name "活动名" [--goal product_launch] [--videos v1,v2] [--daily-quota 50] [--min-priority 0]');
  }
  const filters = { minPriority: getFlag(args, '--min-priority', 0) };
  const goal = getFlag(args, '--goal', null);
  return campaigns.create({
    name: String(name),
    goal: goal != null ? String(goal) : null,
    videos: parseCsv(getFlag(args, '--videos', null)),
    filters,
    dailyQuota: getFlag(args, '--daily-quota', 50),
    perUserQuota: getFlag(args, '--per-user-quota', 1),
  });
}

async function subList() {
  return campaigns.list();
}

async function subStatus(ctx, args) {
  const id = positionalId(args);
  if (!id) throw new Error('用法: campaign status <id>');
  const camp = campaigns.get(id);
  if (!camp) throw new Error(`活动 ${id} 不存在`);
  return { campaign: camp, tasks: campaigns.countByOutcome(id) };
}

async function subPause(ctx, args) {
  const id = positionalId(args);
  if (!id) throw new Error('用法: campaign pause <id>');
  return campaigns.updateStatus(id, 'paused');
}

async function subResume(ctx, args) {
  const id = positionalId(args);
  if (!id) throw new Error('用法: campaign resume <id>');
  return campaigns.updateStatus(id, 'running');
}

/**
 * plan：拉每个视频的评论 → 过滤 → LLM 生成回复 → 入 task（不发送）。
 * 幂等：UNIQUE(campaign_id, cid) 保证重复 plan 不重复入。
 */
async function subPlan(ctx, args) {
  const id = positionalId(args);
  if (!id) throw new Error('用法: campaign plan <id>');
  const camp = campaigns.get(id);
  if (!camp) throw new Error(`活动 ${id} 不存在`);
  const videos = camp.videos || [];
  if (!videos.length) throw new Error('活动未配置 videos，无法 plan（create 时 --videos v1,v2）');

  const llm = require('../llm');
  const client = new llm.LLMClient(ctx.config.llm || {});
  const repoFacts = repoInfo.readAnyCache();
  let strategy = '';
  try { strategy = fs.readFileSync(path.join(process.cwd(), 'reply-strategy.md'), 'utf8'); } catch (e) { /* */ }

  const stats = { videos: videos.length, comments_seen: 0, inserted: 0, skipped: 0 };

  for (const awemeId of videos) {
    let cmts = [];
    try {
      cmts = await ctx.cmdGet([awemeId, '--pages', '2']);
    } catch (e) {
      console.error(`[campaign ${id}] 拉 ${awemeId} 评论失败: ${e.message}`);
      continue;
    }
    const list = Array.isArray(cmts) ? cmts : [];
    stats.comments_seen += list.length;

    for (const c of list) {
      const cid = String(c.cid);
      const uid = c.user?.uid ? String(c.user.uid) : null;

      // 过滤：已回复 / 贴纸 / blacklist
      const existing = comments.get(cid);
      if (existing?.replied) { stats.skipped++; continue; }
      if (existing?.is_sticker) { stats.skipped++; continue; }
      if (uid) {
        const u = users.get(uid);
        if (u?.tier === 'blacklist') { stats.skipped++; continue; }
      }

      // LLM 生成回复
      let replyText = null;
      try {
        const suggestions = await client.suggestReplies(
          [{ cid, text: c.text, uid }],
          strategy, '', { repoFacts }, null
        );
        replyText = suggestions?.[0]?.reply;
      } catch (e) {
        console.error(`[campaign ${id}] LLM 生成失败 cid=${cid}: ${e.message}`);
      }
      if (!replyText) { stats.skipped++; continue; }

      if (campaigns.taskUpsert({ campaignId: id, cid, awemeId, replyText })) {
        stats.inserted++;
      } else {
        stats.skipped++; // 已存在
      }
    }
  }

  campaigns.setStats(id, stats);
  console.error(`[campaign ${id}] plan 完成: ${stats.inserted} 新增 / ${stats.skipped} 跳过 / ${stats.comments_seen} 评论`);
  return { campaign_id: id, ...stats };
}

/**
 * run：前台循环跑 due task。
 * 每条：preflightPublish 预检 → adaptiveInterval 节奏 → cmdPost(--no-throttle) → markExecuted。
 * 风控触发（status_code=8）或 postpone blocker → 停止本轮。
 */
async function subRun(ctx, args) {
  const id = positionalId(args);
  if (!id) throw new Error('用法: campaign run <id> [--limit N]');
  const limit = getFlag(args, '--limit', 50);
  const camp = campaigns.get(id);
  if (!camp) throw new Error(`活动 ${id} 不存在`);
  campaigns.updateStatus(id, 'running');

  const results = { posted: 0, failed: 0, skipped: 0, postponed: 0 };
  let processed = 0;

  while (processed < limit) {
    const due = campaigns.getDue(id, { limit: 1 });
    if (due.length === 0) break;
    const task = due[0];
    processed++;

    // 预检
    const pf = riskControl.preflightPublish({ cid: task.cid, replyText: task.replyText });
    if (!pf.ok) {
      const postpone = pf.blockers.find(b => b.action === 'postpone');
      if (postpone) {
        results.postponed++;
        campaigns.setStats(id, { ...results, ...campaigns.countByOutcome(id) });
        console.error(`⏸ [campaign ${id}] 推迟：${postpone.reason}，停止本轮`);
        return { campaign_id: id, ...results, stopped: postpone.reason };
      }
      const reason = pf.blockers.map(b => b.reason).join(';');
      campaigns.markExecuted(task.id, 'skipped', reason);
      results.skipped++;
      console.error(`⏭ [campaign ${id}] skip: ${reason}`);
      continue;
    }

    // 自适应间隔（非首条）
    if (results.posted + results.failed > 0) {
      const ai = riskControl.adaptiveInterval(id);
      const sec = Math.round(ai.intervalMs / 1000);
      console.error(`⏳ [campaign ${id}] 等待 ${sec}s (${ai.reasons.join(', ') || 'base'}) 后发布...`);
      await new Promise(r => setTimeout(r, ai.intervalMs));
    }

    try {
      await ctx.cmdPost([task.awemeId, task.replyText, '--reply-to', task.cid, '--no-throttle']);
      campaigns.markExecuted(task.id, 'posted');
      results.posted++;
      console.error(`✓ [campaign ${id}] posted: ${(task.replyText || '').slice(0, 30)}...`);
    } catch (e) {
      campaigns.markExecuted(task.id, 'failed', e.message);
      results.failed++;
      console.error(`✗ [campaign ${id}] failed: ${e.message}`);
      if (/status_code=8|status_code=2053|风控/.test(e.message)) {
        console.error(`⚠️ [campaign ${id}] 风控触发，停止本轮`);
        break;
      }
    }
  }

  campaigns.setStats(id, { ...results, ...campaigns.countByOutcome(id) });
  if (campaigns.countByOutcome(id).pending === 0) {
    campaigns.updateStatus(id, 'done');
  }
  return { campaign_id: id, ...results, processed };
}

module.exports = cmdCampaign;
