// lib/commands/factcheck.js — 推广评论发布前事实校验
//
// `node cli.js factcheck "<文本>"`
// 扫描评论里的具体 claim（star 数 / 仓库名 / 版本号），与 storage/repo_facts.json
// （repo-info 缓存）交叉核对。claim 对不上缓存事实 → 拒绝发布。
//
// 解决问题 3 的"发布前无校验门"：dedup 只查文本重复，factcheck 查事实真伪。
// 无 claim 的纯价值表述（如"免费开源，欢迎交流"）→ ok=true（无需校验）。

const repoInfo = require('./repo-info');

function extractClaims(text) {
  const claims = [];
  let m;

  // star 数：数字紧邻 star/⭐/赞（前或后）
  const starRe = /(\d+)\s*(?:star|⭐|赞)|(?:star|⭐|赞)\D{0,6}(\d+)/gi;
  while ((m = starRe.exec(text)) !== null) {
    const n = Number(m[1] || m[2]);
    if (!isNaN(n)) claims.push({ type: 'stars', value: n, span: m[0] });
  }

  // 仓库名：Yht20927/<repo>
  const repoRe = /Yht20927\/([A-Za-z0-9_.\-]+)/g;
  while ((m = repoRe.exec(text)) !== null) {
    claims.push({ type: 'repo', value: m[1], span: m[0] });
  }

  // 版本号：v1.2 / v1.2.3（带 v 前缀，避免误抓普通小数）
  const verRe = /\bv(\d+\.\d+(?:\.\d+)?)\b/gi;
  while ((m = verRe.exec(text)) !== null) {
    claims.push({ type: 'version', value: m[1], span: m[0] });
  }

  return claims;
}

function verify(claims, facts) {
  return claims.map(c => {
    let grounded = false;
    let detail = '';
    if (c.type === 'stars') {
      grounded = facts.stars != null && c.value === facts.stars;
      detail = `claim=${c.value} vs 实际=${facts.stars}`;
    } else if (c.type === 'repo') {
      grounded = !!(facts.full_name && facts.full_name.endsWith('/' + c.value));
      detail = `claim=Yht20927/${c.value} vs 实际=${facts.full_name}`;
    } else if (c.type === 'version') {
      const tag = facts.latest_release && facts.latest_release.tag;
      grounded = tag ? (tag === c.value || tag === 'v' + c.value || tag.endsWith(c.value)) : false;
      detail = `claim=v${c.value} vs 实际 release=${tag || '无'}`;
    }
    return { ...c, grounded, detail };
  });
}

async function cmdFactcheck(ctx, args) {
  const text = args.find(a => typeof a === 'string' && !a.startsWith('--'));
  if (!text) throw new Error('用法: node cli.js factcheck "<文本>"');

  const facts = repoInfo.readAnyCache();
  if (!facts) {
    return {
      ok: null,
      text,
      warning: '未找到仓库事实缓存。推广评论发布前请先跑 `node cli.js repo-info` 获取真实事实。',
      claims: [],
    };
  }

  const claims = verify(extractClaims(text), facts);
  const ungrounded = claims.filter(c => !c.grounded).map(c => ({ ...c }));
  return {
    ok: ungrounded.length === 0,
    text,
    repo_facts_source: facts.full_name,
    claims,
    ungrounded,
    hint: ungrounded.length === 0
      ? (claims.length ? '所有 claim 均基于缓存事实' : '无具体 claim，纯价值表述，放行')
      : `存在 ${ungrounded.length} 个未落地 claim，请改写或重跑 repo-info`,
  };
}

module.exports = cmdFactcheck;
module.exports.extractClaims = extractClaims;
