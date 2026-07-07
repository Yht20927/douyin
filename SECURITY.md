# Security Policy

> 适用版本: v3 · 最后更新: 2026-07-07 · 维护者: Yht20927

---

## 报告漏洞

**请勿在公开 issue 中报告安全漏洞。**

优先渠道：
1. **GitHub Security Advisory**（推荐）— 仓库 Security 标签 → "Report a vulnerability"，私密协作披露
2. 邮件：`2094632273@qq.com`，主题前缀 `[douyin-cli security]`

报告请包含：影响版本、复现步骤、影响范围、建议修复方向。收到后 72 小时内响应。

---

## 支持版本

| 版本 | 状态 |
|------|------|
| `main`（最新） | ✅ 维护中 |
| 旧 release tag | ⚠️ 不回溯修复，请升到最新 |

---

## 范围

本策略覆盖：
- `cli.js` / `server.js` / `lib/**`（Node 端）
- `scripts/douyin.user.js`（油猴脚本，浏览器侧）
- Bridge Server 协议（`:19422` HTTP/WS）

## 不在范围

- **抖音平台侧的风控判定**：本工具在用户**自有账号**上执行用户授权的操作；是否合规使用抖音平台由终端用户自行承担。
- **油猴脚本注入的其他第三方脚本**：仅 `scripts/douyin.user.js` 由本项目维护。

---

## 密钥安全

- `config.json` 已在 `.gitignore`，**勿提交**。包含 `bridge.token` 与 `llm.api_key`
- 环境变量优先级更高：`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`，CI 与容器部署用 env 注入
- `storage/`、`logs/`、`*.pid`、`请求.txt`、`响应.txt` 均已 gitignore（含真实用户数据 / 运行时产物）
- 若怀疑密钥泄露：立即在对应平台轮换（DeepSeek/OpenAI key、Bridge token），并按上方渠道报告

---

## 授权边界

本项目用于**用户自有抖音账号**的代管运营：回复真实评论、维护账号活跃度、推广用户自有开源项目。

**禁止用途**（代码层已设守卫，但使用方亦须自律）：
- 伪造数据 / 刷量 / 批量骚扰
- 攻击他人 / 竞品贴脸
- 规避平台内容审查
- 未经授权操作他人账号

`risk-control` 节奏守卫（`enforceDelay` / `adaptiveInterval`）是 **rate-limit pacing**：让请求节奏贴近正常用户使用习惯、尊重接口频控、维护账号健康——**不是"逃避平台检测"**。内容真实性由 `corpus` 去重 + `factcheck` 事实校验 + 内容禁令保证，与节奏守卫解耦。

---

## 已知安全设计

| 维度 | 措施 |
|------|------|
| 密钥 | `config.json` gitignore；env 优先 |
| 签名 | 油猴脚本在页面上下文用原生 `fetch`，自动携带真实 Cookie/签名，**不逆向、不硬编码** |
| Bridge | 本地 `127.0.0.1:19422`，token 鉴权 |
| 输入注入 | 评论文本经 `escapeExpression` 转义后拼接 JS 表达式 |
| 风控 | 10 分钟窗口断路器（post 失败 ≥3 次暂停）；`adaptiveInterval` 自适应退避 |
