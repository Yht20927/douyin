# 🎵 Douyin Comment CLI

> 抖音评论运营 CLI 工具。基于 Bridge Framework（Bridge Server + 油猴脚本），支持视频搜索、评论获取、**AI 人格化回复**、**行为模拟**、运营仪表盘。

核心亮点：**内置反检测引擎** — 人格化回复 + 随机延迟 + 请求参数随机化 + 浏览行为模拟，让自动化操作更像真人。

---

## ✨ 核心功能

| 功能 | 说明 |
|------|------|
| 🔍 视频搜索 | 关键词搜索视频 |
| 💬 评论获取 | 获取评论及嵌套回复，`--new` 增量拉取 |
| 🤖 **AI 人格化回复** | 7 种人格自动轮换，避免"AI 味" |
| 🎭 **行为模拟** | 模拟真实浏览（搜索→看视频→点赞），穿插在发布流程中 |
| ⏱️ **随机延迟** | 发布间隔 45-180s 随机 + 疲劳累加，模拟真人节奏 |
| 🎲 **请求参数随机化** | browser_version 动态获取、paste_edit_method / enter_from 随机切换 |
| 🛡️ 风控断路器 | 10 分钟内 post 失败 ≥3 次自动暂停 |
| 📥 视频下载 | 下载视频+音频（BGM） |
| 📊 运营仪表盘 | 本地 HTML 可视化 |
| 💾 持久化记忆 | SQLite 存储评论、语料、失败模式 |

---

## 🚀 快速开始

```bash
npm install

# 1. 复制配置
cp config.example.json config.json
# 编辑 config.json：填入 bridge.token 和 llm.api_key

# 2. 启动 Bridge Server
node server.js

# 3. Chrome 安装油猴脚本 scripts/douyin.user.js
#    打开 douyin.com 并登录

# 4. 验证连接
node cli.js my

# 5. 开始使用
node cli.js my
node cli.js search "关键词"
node cli.js get <aweme_id> --pages 1 --count 5
node cli.js suggest <aweme_id> --auto
```

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

# 调试模式（跳过所有延迟）
node cli.js suggest <aweme_id> --fast
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

抖音油猴脚本内置多项反检测参数随机化：

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
| `search` | 搜索视频 | `node cli.js search "关键词" --count 5` |
| `get` | 获取评论 | `node cli.js get <id> --pages 1 --count 5` |
| `post` | 发表评论/回复 | `node cli.js post <id> "内容" --reply-to <cid>` |
| `like` | 点赞视频 | `node cli.js like <id>` |
| `delete-comment` | 删除评论 | `node cli.js delete-comment <cid>` |
| `download` | 下载视频+音频 | `node cli.js download <id>` |

### AI 与运营

| 命令 | 用途 | 示例 |
|------|------|------|
| `analyze` | AI 分析评论情感/优先级 | `node cli.js analyze <id>` |
| `suggest` | AI 生成回复建议 | `node cli.js suggest <id> --auto` |
| `browse` | 模拟浏览行为 | `node cli.js browse --max-notes 2` |
| `dashboard` | 运营仪表盘 HTML | `node cli.js dashboard` |

### 反馈闭环（SQLite 记忆层）

| 命令 | 用途 |
|------|------|
| `replied` | 已回复 cid 列表 |
| `corpus search/recent/stats` | 回复语料库 |
| `failures` | 失败模式 top 10 |
| `dedup` | 查重护栏 |

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
  }
}
```

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

**新增反检测模块**：
- `lib/jitter.js` — 人类行为延迟工具库
- `lib/personas.js` — 7 种人格模板池
- `lib/commands/browse.js` — 模拟浏览行为

---

## 🛡️ 反检测设计

| 检测维度 | 对策 |
|----------|------|
| **固定时间间隔** | 发布间隔 45-180s 随机 + 疲劳累加 |
| **AI 内容特征** | 7 种人格自动轮换 + AI 特征词黑名单 |
| **只发不看** | 每发 ~5 条穿插 browse 浏览+点赞 |
| **静态请求指纹** | browser_version 动态获取、paste_edit_method / enter_from 随机化 |
| **重复内容** | reply_corpus UNIQUE 去重 + LLM 重写 |
| **高频失败** | 10 分钟窗口断路器（非累计值） |

---

## 📁 项目结构

```
douyin-cli/
├── cli.js                    # CLI 入口
├── server.js                 # Bridge Server
├── config.json               # 配置
├── lib/
│   ├── commands/             # 命令模块
│   │   ├── get.js            # 获取评论
│   │   ├── post.js           # 发表评论
│   │   ├── suggest.js        # AI 回复建议（含人格化+随机延迟）
│   │   ├── browse.js         # 模拟浏览行为
│   │   ├── search.js         # 搜索视频
│   │   ├── download.js       # 下载视频+音频
│   │   └── ...
│   ├── memory/               # SQLite 持久化记忆层
│   ├── personas.js           # 7 种人格模板池
│   ├── jitter.js             # 人类行为延迟工具库
│   ├── llm.js                # LLM 封装（支持人格化）
│   └── ...
├── scripts/
│   └── douyin.user.js        # 油猴脚本（含参数随机化）
├── storage/
│   └── douyin.db             # SQLite 数据库
├── reply-strategy.md         # 回复策略模板
├── SKILL.md                  # Agent 技能文档
└── README.md                 # 本文档
```

---

## 📦 依赖

- Node.js 18+
- `ws` — WebSocket
- `better-sqlite3` — SQLite
- Chrome + Tampermonkey + 油猴脚本
- （可选）OpenAI-compatible API key

---

## 📝 License

MIT
