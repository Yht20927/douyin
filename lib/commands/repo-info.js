// lib/commands/repo-info.js — 获取 GitHub 仓库真实信息（推广评论事实源）
//
// 解决"忽略获取信息而胡编"问题（问题 3 根因）：
// 推广评论生成前必须先跑本命令，结果缓存到 storage/repo_facts.json（1h 内复用），
// 供 suggest 注入 LLM 上下文 + factcheck 发布前校验。
//
// 调用 gh-cli（用户已授权的自有仓库）；gh 未登录或缺包时抛带提示的错误。

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
const DEFAULT_OWNER = 'Yht20927';
const DEFAULT_REPO = 'douyin-cli';

function storageDir() {
  return process.env.DOUYIN_STORAGE_DIR
    ? path.resolve(process.env.DOUYIN_STORAGE_DIR)
    : path.join(__dirname, '..', '..', 'storage');
}

function cachePath() {
  return path.join(storageDir(), 'repo_facts.json');
}

function parseRepoArg(arg) {
  if (!arg || arg.startsWith('--')) return { owner: DEFAULT_OWNER, repo: DEFAULT_REPO };
  if (arg.includes('/')) {
    const [owner, repo] = arg.split('/');
    return { owner: owner || DEFAULT_OWNER, repo: repo || DEFAULT_REPO };
  }
  return { owner: DEFAULT_OWNER, repo: arg };
}

function fetchFromGh(owner, repo) {
  const fields = 'name,description,stargazerCount,forkCount,pushedAt,url,latestRelease,primaryLanguage';
  try {
    const out = execFileSync('gh', [
      'repo', 'view', `${owner}/${repo}`,
      '--json', fields,
    ], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out);
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().split('\n')[0] : '';
    const hint = (e.code === 'ENOENT')
      ? 'gh 命令未找到，请先安装 GitHub CLI 并 `gh auth login`'
      : '请确认 gh 已登录（gh auth login）且仓库存在';
    throw new Error(`gh repo view 失败（${owner}/${repo}）：${stderr || e.message.split('\n')[0]}。${hint}`);
  }
}

function readCache(owner, repo) {
  try {
    const p = cachePath();
    if (!fs.existsSync(p)) return null;
    const stat = fs.statSync(p);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    const cached = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!cached || cached.full_name !== `${owner}/${repo}`) return null;
    return cached;
  } catch (e) {
    return null;
  }
}

/** 读取任意已缓存的仓库事实（供 suggest 注入用，不校验 repo 名）。过期或缺失返回 null。 */
function readAnyCache() {
  try {
    const p = cachePath();
    if (!fs.existsSync(p)) return null;
    const stat = fs.statSync(p);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeCache(facts) {
  try {
    const dir = storageDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(facts, null, 2));
  } catch (e) {
    if (process.env.DOUYIN_DEBUG) console.warn('[repo-info] cache write failed:', e.message);
  }
}

/**
 * @param {object} ctx
 * @param {string[]} args - [<owner/repo | repo>, --refresh]
 */
async function cmdRepoInfo(ctx, args) {
  const { owner, repo } = parseRepoArg(args[0]);
  const refresh = args.includes('--refresh');

  if (!refresh) {
    const cached = readCache(owner, repo);
    if (cached) {
      console.error(`[repo-info] 命中缓存（${owner}/${repo}，<1h）`);
      return cached;
    }
  }

  const raw = fetchFromGh(owner, repo);
  const facts = {
    full_name: `${owner}/${repo}`,
    name: raw.name,
    description: raw.description,
    stars: raw.stargazerCount,
    forks: raw.forkCount,
    pushed_at: raw.pushedAt,
    url: raw.url,
    latest_release: raw.latestRelease
      ? {
          tag: raw.latestRelease.tagName,
          published_at: raw.latestRelease.publishedAt,
          notes: (raw.latestRelease.description || '').slice(0, 200) || null,
        }
      : null,
    primary_language: raw.primaryLanguage ? raw.primaryLanguage.name : null,
    fetched_at: Date.now(),
  };
  writeCache(facts);
  console.error(`[repo-info] 已获取并缓存（${owner}/${repo}，stars=${facts.stars}）`);
  return facts;
}

module.exports = cmdRepoInfo;
module.exports.cachePath = cachePath;
module.exports.readCache = readCache;
module.exports.readAnyCache = readAnyCache;
