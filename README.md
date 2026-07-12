# 🎵 Douyin Comment CLI

[![test](https://github.com/Yht20927/douyin-cli/actions/workflows/test.yml/badge.svg)](https://github.com/Yht20927/douyin-cli/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> 适用版本: v4 · 最后更新: 2026-07-12 · 维护者: Yht20927

> 抖音评论运营 CLI 工具。基于 Bridge Framework（Bridge Server + 油猴脚本），支持视频搜索、评论获取、**AI 人格化回复**、**ReplyEngine 独立生成**、**草稿管理**、运营仪表盘。

核心亮点：**ReplyEngine 评论生成引擎**（generateComment / generateReply / generateReplies）+ **A-F 六类回复策略** + **Anthropic & OpenAI 双 Provider 支持** + **Token 用量追踪**，让代管自有账号的评论运营全流程自动化。

---

## ✨ 核心功能

| 功能 | 说明 |
|------|------|
| 🔍 视频搜索 | 关键词搜索视频 |
| 💬 评论获取 | 获取评论及嵌套回复，`--new` 增量拉取 |
| 🧠 **ReplyEngine** | 独立评论生成引擎，3 种模式 + 人格绑定 + 上下文隔离 |
| 🤖 **AI 人格化回复** | 7 种人格自动轮换，A-F 六类回复策略，避免"AI 味" |
| 📝 **草稿管理** | 回复草稿 save/list/show/post/delete 完整生命周期 |
| 🎭 **行为模拟** | 模拟真实浏览（搜索→看视频→点赞），穿插在发布流程中 |
| ⏱️ **随机延迟** | 发布间隔 40-55s 随机 + 疲劳累加，模拟真人节奏 |
| 🎲 **请求参数随机化** | browser_version 动态获取、paste_edit_method / enter_from 随机切换 |
| 🛡️ 风控断路器 | 10 分钟内 post 失败 ≥3 次自动暂停 |
| 📥 视频下载 | 下载视频+音频（BGM），支持 ffmpeg 截图多模态分析 |
| 📊 运营仪表盘 | 本地 HTML 可视化，含推广活动卡片 |
| 💾 持久化记忆 | SQLite schema v8（events / users / videos / comments / corpus / failures / campaigns / llm_usage / drafts） |

---

## 🚀 快速开始

```bash
npm install

# 1. 复制配置
cp config.example.json config.json
# 编辑 config.json：填入 bridge.token 和 llm.api_key
# 支持 OpenAI 兼容 API 和 Anthropic 原生 Messages API（自动检测切换）

# 2. 启动 Bridge Server
node server.js

# 3. Chrome 安装油猴脚本 scripts/douyin.user.js
#    打开 douyin.com 并登录

# 4. 验证连接
node cli.js my

# 5. 开始使用
node cli.js search "关键词"
node cli.js get <aweme_id> --pages 1 --count 5
node cli.js suggest <aweme_id> --auto
node cli.js getReply <aweme_id> --batch
```

---

## 🧠 ReplyEngine 评论生成引擎

独立于 suggest 命令的新一代评论生成系统，支持三种模式：

```bash
# 评论模式：以普通用户身份生成视频的顶级评论
node cli.js getReply <aweme_id>
node cli.js getReply <aweme_id> --count 3           # 多条候选
node cli.js getReply <aweme_id> --persona casual_friend  # 指定人格

# 回复模式：以博主身份回复单条评论
node cli.js getReply <aweme_id> <cid>               # 自动加载视频上下文 + 用户画像
node cli.js getReply <aweme_id> <cid> --interactive  # 交互式审核（生成→编辑→发布）

# 批量模式：对视频下所有未回复评论批量生成回复
node cli.js getReply <aweme_id> --batch              # 自动跳过作者自评
```

**ReplyEngine 架构**：
- **人格绑定**（persona-binder）：同视频复用人格，第 8 条自动换风格，microAdjust 微调温度
- **上下文隔离**（context-scope）：L1 本视频语料 → L2 全局成功语料 → L3 失败模式避雷
- **多模态**（video-context）：支持 text-only / screenshots（ffmpeg 取帧）/ video 三种模式
- **A-F 回复策略**：提问型 / 赞美型 / 讨论型 / 简短型 / 批评质疑型 / 艾特型

---

## 🤖 AI 人格化回复

**7 种内置人格自动轮换**，每条评论风格不同：

| 人格 | 特征 | 示例 |
|------|------|------|
| casual 朋友 | 口语短句，1-2 个 emoji | "哈哈哈这也太真实了😂" |
| 好奇提问型 | 以问句为主，真诚追问 | "这个是在哪里买的呀？" |
| 经验分享型 | "我之前也..." | "我之前试过，确实不错" |
| 热情追捧型 | 感叹号+emoji，情绪化 | "啊啊啊这个绝了！！" |
| 温和探讨型 | "我觉得..."委婉补充 | "说得挺有道理的，不过..." |
| 轻松幽默型 | 玩梗、自嘲、夸张 | "我的手：我会了 我的脑：不你不会" |
| 简短反应型 | 极简，3-15 字 | "真实👍" "马住了" |

使用：
```bash
# 生成建议（不发布，看风格）
node cli.js suggest <aweme_id>

# 自动发布（人格轮换 + 随机延迟 + 浏览穿插）
node cli.js suggest <aweme_id> --auto

# ReplyEngine 单条回复（自动绑定人格 + 用户画像注入）
node cli.js getReply <aweme_id> <cid>
```

---

## 🎭 行为模拟（browse）

模拟真实用户浏览行为，解决"只发不看"的账户不对称检测：

```bash
# 随机搜索热门词 → 看 1-2 个视频 → 偶尔点赞评论
node cli.js browse --max-notes 2 --like-chance 0.2

# 指定关键词浏览
node cli.js browse 穿搭 美食 --max-notes 3
```

`suggest --auto` 已内置 browse 穿插：**每发约 5 条评论自动穿插一次浏览+点赞**。

---

## 🎲 请求参数随机化

抖音油猴脚本内置多项请求参数随机化：

| 参数 | 随机化策略 |
|------|-----------|
| `browser_version` | 动态读取 `navigator.userAgent`（非硬编码） |
| `paste_edit_method` | 90% `non_paste` / 10% `paste` |
| `enter_from` | 85% `others_homepage` / 15% `search_result` |
| `previous_page` | 85% `others_homepage` / 15% `homepage` |

---

## 📋 命令清单

### 核心操作

| 命令 | 用途 | 示例 |
|------|------|------|
| `my` | 我的作品列表 | `node cli.js my` |
| `user` | 查看用户作品信息 | `node cli.js user <sec_user_id\|主页URL>` |
| `search` | 搜索视频 | `node cli.js search "关键词" --count 5` |
| `get` | 获取评论 | `node cli.js get <id> --pages 1 --count 5` |
| `replies` | 获取回复列表 | `node cli.js replies <cid> <aweme_id>` |
| `post` | 发表评论/回复 | `node cli.js post <id> "内容" --reply-to <cid>` |
| `like` | 点赞视频 | `node cli.js like <id>` |
| `delete-comment` | 删除评论 | `node cli.js delete-comment <cid>` |
| `download` | 下载视频+音频 | `node cli.js download <id> [--audio-only]` |

### AI 与运营

| 命令 | 用途 | 示例 |
|------|------|------|
| `analyze` | AI 分析评论情感/优先级 | `node cli.js analyze <id>` |
| `suggest` | AI 回复建议 + 自动发布 | `node cli.js suggest <id> --auto` |
| `getReply` | **ReplyEngine 生成评论/回复** | `node cli.js getReply <id> [<cid>] [--batch]` |
| `draft` | **草稿管理** | `node cli.js draft <list\|save\|show\|post\|delete>` |
| `browse` | 模拟浏览行为 | `node cli.js browse --max-notes 2` |
| `dashboard` | 运营仪表盘 HTML | `node cli.js dashboard` |

### 反馈闭环（SQLite 记忆层）

| 命令 | 用途 |
|------|------|
| `replied` | 已回复 cid 列表 |
| `corpus search/recent/stats` | 回复语料库 |
| `failures` | 失败模式 top-N（避雷清单） |
| `dedup` | 查重护栏 |
| `whois` | 用户全量画像 |
| `note` | 用户标记（tier/tag/notes） |
| `comment` | **单条评论实体查询** |
| `profile` | 用户交互历史 |
| `events` | 原始事件流 |
| `log` | 操作日志 |

### 守卫与推广

| 命令 | 用途 |
|------|------|
| `preflight` | 节奏守卫自检 |
| `repo-info` | GitHub 仓库真实信息（推广事实源） |
| `factcheck` | 推广评论发布前事实校验 |
| `campaign` | 推广引擎（create/plan/run/stop/status） |
| `validate-prompts` | **校验提示词模板格式** |

### 其他

| 命令 | 用途 |
|------|------|
| `dm` | 私信发送/监听/列表 |
| `cleanup` | 清理过期记忆（TTL） |

---

## ⚙️ 配置

`config.json`（从 `config.example.json` 复制）：

```json
{
  "bridge": {
    "host": "127.0.0.1",
    "port": 19422,
    "token": "your-bridge-token"
  },
  "llm": {
    "api_key": "sk-...",
    "base_url": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "max_tokens": 4096,
    "timeout_ms": 60000,
    "max_retries": 3
  },
  "vision": {
    "screenshot_count": 4,
    "screenshot_width": 1024
  }
}
```

**LLM Provider 自动检测**：
- `base_url` 含 `anthropic.com` → Anthropic 原生 Messages API
- `base_url` 含 `xiaomimimo.com` → MiMo API（api-key 头）
- 其他 → OpenAI 兼容格式（Bearer token）

环境变量（优先级更高）：
```bash
export OPENAI_API_KEY="sk-..."
export OPENAI_BASE_URL="https://..."
export OPENAI_MODEL="gpt-4o-mini"
```

---

## 🏗️ 架构

```
CLI (cli.js) → HTTP/WS → Bridge Server (:19422) → 油猴脚本 → 页面 fetch → 抖音 API
```

**签名安全**：油猴脚本在页面上下文执行，使用页面原生 `fetch`，自动携带真实 Cookie 和签名。

**核心模块**：
- `lib/reply-engine/` — ReplyEngine 评论生成引擎（5 模块）
- `lib/risk-control.js` — 请求节奏守卫（写操作硬强制，单一间隔源）
- `lib/jitter.js` — 节奏与拟人化延迟工具库
- `lib/personas.js` — 7 种人格模板池
- `lib/llm.js` — LLM 客户端（OpenAI + Anthropic 双 Provider，A-F 策略，Token 追踪）
- `lib/commands/browse.js` — 模拟浏览行为
- `lib/commands/campaign.js` — P4 推广引擎

---

## 🛡️ 节奏与拟人化设计

> 语义边界：这是 rate-limit pacing（请求节奏化）+ content humanization（内容拟人化），
> 服务于用户**自有账号**的代管运营，避免触发接口频控、维护账号健康。
> 它不是"逃避平台内容审核"——内容真实性与反刷量由 内容禁令 + corpus 去重 + factcheck 保证。

| 维度 | 对策 |
|------|------|
| **固定时间间隔** | 写操作 40-55s 硬强制（`risk-control` 守卫，读 config.json:intervals） |
| **AI 内容特征** | 7 种人格轮换 + A-F 六类回复策略 + AI 特征词黑名单 |
| **只发不看** | 每发 ~5 条穿插 browse 浏览+点赞 |
| **静态请求指纹** | browser_version 动态获取、paste_edit_method / enter_from 随机化 |
| **重复内容** | reply_corpus UNIQUE 去重 + LLM 重写 |
| **回复质量** | 禁止单字/单表情回复，最少 8 字，ReplyEngine 上下文隔离 |
| **高频失败** | 10 分钟窗口断路器（非累计值） |

---

## 📁 项目结构

```
douyin-cli/
├── cli.js                    # CLI 入口（命令路由 + help）
├── server.js                 # Bridge Server（WebSocket + HTTP /api/status）
├── config.example.json       # 配置模板（bridge + llm + vision）
├── CONTRIBUTING.md           # 贡献指南
├── SECURITY.md               # 安全策略
├── DISCLAIMER.md             # 免责声明
├── lib/
│   ├── commands/             # 命令模块（32 个命令，注册在 index.js）
│   │   ├── get/post/like/delete-comment.js    # 核心 CRUD
│   │   ├── search/my/user/replies/download.js # 读取类
│   │   ├── analyze/suggest.js                 # LLM 分析与回复
│   │   ├── getReply.js                        # ReplyEngine 评论/回复生成
│   │   ├── draft.js                           # 草稿管理
│   │   ├── comment.js                         # 单条评论查询
│   │   ├── validatePrompts.js                 # 提示词模板校验
│   │   ├── browse.js                          # 模拟浏览行为
│   │   ├── campaign.js                        # P4 推广引擎
│   │   ├── preflight/repo-info/factcheck.js   # 节奏与事实守卫
│   │   ├── whois/note/events/log/profile.js   # 记忆层查询
│   │   ├── corpus/failures/dedup/replied.js   # 语料 / 失败 / 查重
│   │   └── dashboard/dm/cleanup.js
│   ├── reply-engine/         # ReplyEngine 评论生成引擎（v4 新增）
│   │   ├── index.js          # 主类（generateComment/generateReply/generateReplies）
│   │   ├── persona-binder.js # 人格绑定 + microAdjust
│   │   ├── context-scope.js  # 三层上下文隔离（L1/L2/L3）
│   │   ├── prompt-builder.js # 5 种 Prompt 模式组装器
│   │   └── video-context.js  # 视频上下文加载（含 ffmpeg 截图）
│   ├── memory/               # SQLite 持久化记忆层
│   │   ├── db.js             # 单例 + WAL + schema 迁移（v8）
│   │   ├── events/users/comments/videos.js
│   │   ├── corpus/failures/campaigns.js
│   │   ├── drafts.js         # 草稿管理（v4 新增）
│   │   └── llm-usage.js      # LLM Token 用量追踪（v4 新增）
│   ├── shared/               # 共享工具
│   │   ├── serialize.js / parseResponse.js / protocol.js
│   │   └── caseConvert.js    # camelCase → snake_case（v4 新增）
│   ├── client/               # Bridge 客户端
│   ├── server/               # WS Hub + Router + Registry
│   ├── risk-control.js       # 请求节奏守卫 + 自适应风控
│   ├── llm.js                # LLM 客户端（OpenAI + Anthropic + Token 追踪）
│   ├── personas.js           # 7 种人格模板池
│   ├── jitter.js             # 节奏与拟人化延迟
│   ├── audit.js              # 审计日志（SQLite 双写）
│   └── dashboard.js          # HTML 仪表盘
├── prompts/                  # LLM Prompt 模板（用户可编辑，v4 新增）
│   ├── analyze.md            # 评论分析 Prompt
│   ├── suggest.md            # 回复建议 Prompt
│   ├── comment.md            # 顶级评论生成 Prompt
│   ├── reply.md              # 单条回复 Prompt
│   └── replies-batch.md      # 批量回复 Prompt
├── scripts/
│   ├── douyin.user.js        # 油猴脚本（页面 fetch + 参数随机化）
│   ├── _template.user.js     # 新站点油猴模板
│   └── bridge.sh             # Bridge Server 生命周期管理
├── tests/                    # vitest（182 用例，15 文件）
│   ├── reply-engine/         # ReplyEngine 测试（v4 新增）
│   ├── drafts.test.js        # 草稿测试（v4 新增）
│   └── caseConvert.test.js   # caseConvert 测试（v4 新增）
├── storage/                  # SQLite DB（gitignore）
└── logs/                     # 审计日志 + 结果文件（gitignore）
```

---

## 📦 依赖

- Node.js 18+
- `ws` — WebSocket
- `better-sqlite3` — SQLite
- Chrome + Tampermonkey + 油猴脚本
- LLM API key（OpenAI 兼容或 Anthropic 原生）

---

## 🤝 贡献与安全

- 贡献指南、开发环境、代码约定见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- 安全策略、漏洞报告、密钥安全、授权边界见 [`SECURITY.md`](./SECURITY.md)
- 免责声明见 [`DISCLAIMER.md`](./DISCLAIMER.md)

---

## 📝 License

MIT
