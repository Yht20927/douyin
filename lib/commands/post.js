// lib/commands/post.js — 发表评论/回复

const { escapeExpression, getFlag } = require('./helpers');
const users = require('../memory/users');
const comments = require('../memory/comments');
const videos = require('../memory/videos');
const corpus = require('../memory/corpus');
const failures = require('../memory/failures');

/**
 * 发表评论或回复
 * @param {object} ctx - { bridge, audit, loggedCall }
 * @param {string[]} args - [aweme_id, text, --reply-to <cid>, --reply-to-reply <rrid>, --at <uid> <sec_uid>]
 */
async function cmdPost(ctx, args) {
  const awemeId = args[0];
  const text = args[1];
  if (!awemeId || !text) throw new Error('用法: node cli.js post <aweme_id> "内容" [--reply-to <cid>]');
  const replyTo = getFlag(args, '--reply-to', null);
  const rrid = getFlag(args, '--reply-to-reply', null);

  // @ 提及支持
  let atUid = null, atSecUid = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--at') { atUid = args[++i]; atSecUid = args[++i]; }
  }

  let mentions = 'null';
  if (atUid && atSecUid) {
    const atPos = text.indexOf('@');
    if (atPos >= 0) {
      let charEnd = atPos + 1;
      while (charEnd < text.length && text[charEnd] !== ' ') charEnd++;
      const byteStart = Buffer.byteLength(text.substring(0, atPos), 'utf8');
      const byteEnd = Buffer.byteLength(text.substring(0, charEnd), 'utf8');
      mentions = JSON.stringify([{
        start: byteStart, end: byteEnd,
        user_id: atUid, sec_uid: atSecUid, type: 0,
      }]);
    }
  }

  ctx.audit.startOperation('post', { aweme_id: awemeId, text, reply_to: replyTo });
  const expr = `window.__bridge.publish('${escapeExpression(awemeId)}', '${escapeExpression(text)}', ${replyTo ? `'${escapeExpression(replyTo)}'` : 'null'}, ${rrid ? `'${escapeExpression(rrid)}'` : 'null'}, ${mentions})`;
  let data;
  try {
    data = await ctx.loggedCall('post', { aweme_id: awemeId, text }, expr);
  } catch (e) {
    // transport/bridge 错误也落 failure_patterns（闭环避雷，对齐 xhs post.js）
    try { failures.record(e, { exampleText: text.slice(0, 200) }); } catch (_) {}
    ctx.audit.endOperation('error', {}, null, e.message);
    throw e;
  }

  // 检查 status_code（非 0 即为失败）
  if (data.status_code !== undefined && data.status_code !== 0) {
    const err = new Error(`status_code=${data.status_code} — 评论可能被拦截，请更换内容重试`);
    try { failures.record({ status_code: data.status_code }, { exampleText: text }); } catch (_) {}
    ctx.audit.endOperation('error', { status_code: data.status_code }, null, err.message);
    throw err;
  }

  if (!data.comment) {
    const err = new Error('发布失败 — 服务器未返回评论数据');
    try { failures.record(err.message, { exampleText: text }); } catch (_) {}
    ctx.audit.endOperation('error', {}, null, err.message);
    throw err;
  }

  const result = {
    cid: data.comment?.cid || '',
    text: data.comment?.text || text,
    time: data.comment?.create_time || 0,
    status: 'published',
  };

  // ── 实体表落库（旁路写，失败不影响主流程）──
  try {
    const myUid = data.comment?.user?.uid || data.comment?.user?.uid_str || null;
    const mySecUid = data.comment?.user?.sec_uid || null;
    const myNickname = data.comment?.user?.nickname || null;
    // 自己（publisher）upsert：仅记录身份，不动 reply_count（reply_count 表示「我回复了该用户多少次」）
    if (myUid) {
      users.upsert({
        uid: String(myUid),
        secUid: mySecUid,
        nickname: myNickname,
      });
    }
    // 自己发的这条评论本身也落库
    if (result.cid) {
      comments.upsert({
        cid: String(result.cid),
        awemeId: String(awemeId),
        uid: myUid ? String(myUid) : null,
        text: result.text,
        createdAt: result.time || null,
        parentCid: replyTo || null,
      });
    }
    // 标记被回复的源评论 + 源评论作者的 reply_count++
    if (replyTo && result.cid) {
      comments.markReplied(String(replyTo), String(awemeId), String(result.cid));
      const src = comments.get(String(replyTo));
      if (src && src.uid) {
        users.upsert({ uid: String(src.uid), replyDelta: 1 });
      }
    }
    videos.markPost(String(awemeId));

    // 成功则把这条回复入语料库（reply_to 才算"回复语料"，对原帖的纯评论不入库）
    if (replyTo) {
      const src = comments.get(String(replyTo));
      corpus.append({
        srcCid: String(replyTo),
        srcText: src ? src.text : null,
        replyText: result.text,
        replyCid: result.cid || null,
        awemeId: String(awemeId),
        postedAt: (result.time && result.time > 1e10) ? Number(result.time) : Date.now(),
        outcome: 'published',
      });
    }
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[cmdPost.persist] failed:', e.message);
  }

  ctx.audit.endOperation('success', { cid: result.cid }, { result });
  return result;
}

module.exports = cmdPost;
