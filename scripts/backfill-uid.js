#!/usr/bin/env node
// scripts/backfill-uid.js — 重抓历史视频补 comments.uid（user_info 修复前的旧数据）
// 用法：node scripts/backfill-uid.js [--limit N]  （每个视频间隔 35s 防风控）
//
// 旧评论（user_info 修复前落库）uid 为 NULL。重抓触发 upsert 合并（COALESCE）补 uid。
// 建议：先 --limit 1 试跑一个，确认无误后逐步增加。

const { execSync } = require('child_process');
const path = require('path');
const { getDb } = require('../lib/memory/db');

const limitIdx = process.argv.indexOf('--limit');
const limit = limitIdx >= 0 && process.argv[limitIdx + 1] ? Number(process.argv[limitIdx + 1]) : 10;

const db = getDb();
const videos = db.prepare(`SELECT DISTINCT aweme_id AS id FROM comments WHERE uid IS NULL LIMIT ?`).all(limit);
console.log(`需 backfill 的视频: ${videos.length}（limit=${limit}）`);
if (!videos.length) { console.log('✓ 无需 backfill（所有评论已有 uid）'); process.exit(0); }

const before = db.prepare(`SELECT count(uid) AS n FROM comments WHERE uid IS NOT NULL`).get().n;
const root = path.resolve(__dirname, '..');

for (let i = 0; i < videos.length; i++) {
  const id = videos[i].id;
  console.error(`[${i + 1}/${videos.length}] 重抓 ${id}...`);
  try {
    execSync(`node cli.js get ${id} --all --depth 0`, { cwd: root, stdio: 'inherit' });
  } catch (e) {
    console.error(`  失败: ${(e.message || '').slice(0, 100)}`);
  }
  if (i < videos.length - 1) {
    console.error('  等待 35s 防风控...');
    execSync('sleep 35');
  }
}

const after = db.prepare(`SELECT count(uid) AS n FROM comments WHERE uid IS NOT NULL`).get().n;
console.log(`\n✓ backfill 完成：有 uid 的评论 ${before} → ${after}（+${after - before}）`);
