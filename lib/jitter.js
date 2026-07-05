// lib/jitter.js — 人类行为延迟工具库（抖音版）
// 为自动化操作注入符合人类行为模式的随机延迟，降低被反作弊系统检测的风险。

const DELAY_RANGES = {
  page_turn:      [800,   2500],   // 翻页/滚动
  read_comment:   [3000,  12000],  // 阅读一条评论
  think_reply:    [5000,  20000],  // 思考回复内容
  post_interval:  [45000, 180000], // 两次发布之间的间隔
  browse_idle:    [1000,  5000],   // 浏览时的随机停顿
  type_char:      [300,   1500],   // 打字（逐字符延迟）
  scroll:         [300,   1200],   // 快速滚动
  switch_tab:     [2000,  8000],   // 切换标签/页面
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, Math.max(0, ms)));
}

async function randomSleep(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return sleep(ms);
}

async function maybeDelay(probability, minMs, maxMs) {
  if (Math.random() < probability) {
    await randomSleep(minMs, maxMs);
  }
}

function jitter(baseMs, percent) {
  const delta = baseMs * percent;
  return baseMs + (Math.random() * 2 - 1) * delta;
}

async function humanDelay(type) {
  return sleep(humanDelayMs(type));
}

function humanDelayMs(type) {
  const [min, max] = DELAY_RANGES[type] || [1000, 3000];
  return min + Math.random() * (max - min);
}

module.exports = {
  sleep,
  randomSleep,
  maybeDelay,
  jitter,
  humanDelay,
  humanDelayMs,
};
