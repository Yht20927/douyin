// lib/commands/browse.js — 模拟浏览行为（抖音版）

const { getFlag } = require('./helpers');
const { humanDelay, maybeDelay } = require('../jitter');

const HOT_KEYWORDS = [
  '穿搭', '美食', '旅行', '护肤', '家居', '宠物', '健身', '读书',
  '摄影', '手工', '绿植', '咖啡', '电影', '音乐', '游戏', '学习',
  '职场', '恋爱', '省钱', '收纳', '早餐', '晚霞', '海边', '露营',
];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickKeywords() {
  const count = 1 + Math.floor(Math.random() * 2);
  return shuffle(HOT_KEYWORDS).slice(0, count);
}

/**
 * 模拟浏览行为
 * @param {object} ctx
 * @param {Array} args
 */
async function cmdBrowse(ctx, args) {
  const keywords = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a === 'string' && a.startsWith('--')) {
      const next = args[i + 1];
      if (next !== undefined && typeof next === 'string' && !next.startsWith('--')) i++;
      continue;
    }
    if (a && String(a).length > 0) keywords.push(String(a));
  }
  const rawMax = Number(getFlag(args, '--max-notes', 3));
  const maxNotes = Math.min(Number.isNaN(rawMax) ? 3 : rawMax, 8);
  const rawLike = Number(getFlag(args, '--like-chance', 0.3));
  const likeChance = Math.min(Number.isNaN(rawLike) ? 0.3 : rawLike, 1.0);
  const fast = args.includes('--fast');

  ctx.audit.startOperation('browse', { max_notes: maxNotes, like_chance: likeChance });

  const picked = keywords.length > 0 ? keywords : pickKeywords();
  console.error(`[browse] 模拟浏览，关键词: ${picked.join(', ')}`);

  let viewedNotes = 0;
  let likedComments = 0;
  const details = [];

  for (const kw of picked) {
    if (!fast) await humanDelay('browse_idle');
    try {
      const searchResults = await ctx.cmdSearch([kw, '--count', '5']);
      if (!searchResults || searchResults.length === 0) continue;

      const toView = shuffle(searchResults).slice(0, 1 + Math.floor(Math.random() * 2));
      for (const note of toView) {
        if (viewedNotes >= maxNotes) break;
        console.error(`[browse] 浏览视频: ${note.title?.slice(0, 30) || note.aweme_id}`);
        if (!fast) await humanDelay('read_comment');

        let comments = [];
        if (Math.random() < 0.5) {
          try {
            comments = await ctx.cmdGet([note.aweme_id, '--pages', '1', '--count', '5']);
            if (!fast) await humanDelay('scroll');
          } catch (e) {
            if (process.env.DOUYIN_DEBUG) console.warn('[browse] get comments failed:', e.message);
          }
        }

        let didLike = false;
        if (comments.length > 0 && Math.random() < likeChance) {
          const target = comments[Math.floor(Math.random() * comments.length)];
          try {
            await ctx.cmdLike([note.aweme_id, target.cid]);
            likedComments++;
            didLike = true;
            console.error(`[browse] 点赞评论: ${target.text?.slice(0, 20) || target.cid}`);
            if (!fast) await humanDelay('browse_idle');
          } catch (e) {
            if (process.env.DOUYIN_DEBUG) console.warn('[browse] like failed:', e.message);
          }
        }

        viewedNotes++;
        details.push({ aweme_id: note.aweme_id, title: note.title, comments_viewed: comments.length, liked: didLike });
      }
    } catch (e) {
      if (process.env.DOUYIN_DEBUG) console.warn(`[browse] search "${kw}" failed:`, e.message);
    }
  }

  const result = { keywords: picked, viewed_notes: viewedNotes, liked_comments: likedComments, details };
  ctx.audit.endOperation('success', result);
  return result;
}

module.exports = cmdBrowse;
