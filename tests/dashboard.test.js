// tests/dashboard.test.js — 仪表盘 HTML 注入防护
//
// audit.js / db.js 的目录常量在 require 时求值，必须在 import 前 set env。

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DOUYIN_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-dash-logs-'));
process.env.DOUYIN_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-dash-store-'));

const { generateDashboardHTML } = require('../lib/dashboard');

describe('dashboard HTML 注入防护', () => {
  it('videoId 注入 <script> 被转义', () => {
    const html = generateDashboardHTML('<script>alert(1)</script>', 7);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('title 与 subtitle 均使用转义后的 videoId', () => {
    const malicious = '<img src=x onerror=alert(2)>';
    const html = generateDashboardHTML(malicious, 14);
    expect(html).toContain(`<title>视频 &lt;img src=x onerror=alert(2)&gt; 评论仪表盘</title>`);
    expect(html).not.toContain(`<h1>视频 ${malicious}`);
  });

  it('正常 videoId 与空态渲染不受影响', () => {
    const html = generateDashboardHTML('7629735841874726179', 3);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('视频 7629735841874726179 评论仪表盘');
    expect(html).toContain('评论总数');
  });
});
