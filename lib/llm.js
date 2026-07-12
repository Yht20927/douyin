// lib/llm.js — OpenAI-compatible LLM 调用封装
// 支持批量分析评论、生成回复建议。内置重试与 JSON 提取容错。
//
// API Key 优先级：环境变量 OPENAI_API_KEY > config.json llm.api_key
// 建议使用环境变量存储密钥，避免提交到版本控制。

let config = {};
try { config = require('../config.json').llm || {}; } catch {}

// 分批大小：防止评论过多导致 token 超限
const BATCH_SIZE = 50;

// 视觉模型 pattern 列表（用于 _supportsVision 检测）
const VISION_MODEL_PATTERNS = [
  'gpt-4o', 'gpt-4-turbo', 'gpt-4-vision', 'gpt-4.1',
  'o1', 'o3', 'o4-mini',
  'claude-3', 'claude-4', 'claude-opus', 'claude-sonnet', 'claude-haiku',
  'gemini-1.5', 'gemini-2', 'gemini-pro',
  'qwen-vl', 'qwen2-vl', 'qwen2.5-vl', 'qvq',
  'pixtral', 'llava', 'cogvlm',
  'llama-3.2', 'llama-4',
  'deepseek-vl', 'glm-4v',
  'mimo-v2.5', 'mimo-v2-omni',
  'deepseek-v4',
];

/**
 * 清洗用户评论内容，防止 prompt 注入
 * - 截断过长文本
 * - 移除可能的指令注入模式
 */
function sanitizeComment(text, maxLen = 200) {
  if (!text) return '';
  let s = String(text).slice(0, maxLen);
  // 移除疑似 prompt 注入的模式（如 "ignore previous", "system:" 等）
  s = s.replace(/\b(ignore|forget|disregard)\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)\b/gi, '[filtered]');
  s = s.replace(/\b(system|assistant|user)\s*:/gi, '[filtered]:');
  s = s.replace(/(忽略|忘记|无视)\s*(以上|之前|上述|前面)\s*(所有)?\s*(指令|规则|提示)/g, '[filtered]');
  return s;
}

class LLMClient {
  constructor(opts = {}) {
    // 环境变量优先，config.json 兜底
    this.apiKey = opts.apiKey || process.env.OPENAI_API_KEY || config.api_key || '';
    this.baseUrl = opts.baseUrl || process.env.OPENAI_BASE_URL || config.base_url || 'https://api.openai.com/v1';
    this.model = opts.model || process.env.OPENAI_MODEL || config.model || 'gpt-4o-mini';
    this.maxRetries = opts.maxRetries || config.max_retries || 3;
    this.timeoutMs = opts.timeoutMs || config.timeout_ms || 60000;
    this.maxTokens = opts.maxTokens || config.max_tokens || 4096;
  }

  /** 检测模型是否支持视觉输入 */
  _supportsVision() {
    if (process.env.DOUYIN_DISABLE_VISION === '1') return false;
    const m = this.model.toLowerCase();
    return VISION_MODEL_PATTERNS.some(p => m.includes(p));
  }

  /** 检测是否为 Mimo 提供商（使用 api-key 头而非 Bearer） */
  _isMimoProvider() {
    return this.baseUrl.includes('xiaomimimo.com');
  }

  /** 检测是否为 OpenAI 官方提供商 */
  _isOpenAIProvider() {
    return this.baseUrl.includes('api.openai.com');
  }

  /** 检测是否为 Anthropic 原生提供商 */
  _isAnthropicProvider() {
    return this.baseUrl.includes('anthropic.com');
  }

  /** 将图片注入到 user 消息中（OpenAI 格式）。支持 base64 data URI 和 URL */
  _injectImagesOpenAI(messages, images) {
    const isOpenAI = this._isOpenAIProvider();
    return messages.map(m => {
      if (m.role !== 'user' || Array.isArray(m.content)) return m;
      const content = [{ type: 'text', text: m.content }];
      for (const img of images.slice(0, 6)) {
        let url;
        if (typeof img === 'string') {
          url = (img.startsWith('data:') || img.startsWith('http')) ? img : `data:image/jpeg;base64,${img}`;
        } else if (img && img.url) {
          url = img.url;
        } else {
          continue;
        }
        const imageBlock = { url };
        // Mimo API 不支持 detail 参数（会报 400）
        if (isOpenAI) imageBlock.detail = 'high';
        content.push({ type: 'image_url', image_url: imageBlock });
      }
      return { ...m, content };
    });
  }

  // ═══════════════════════════════════════════════════════════
  // _call — 统一入口，按 provider 路由
  // ═══════════════════════════════════════════════════════════

  async _call(messages, temperature = 0.3, opts = {}) {
    if (!messages || !messages.length) {
      throw new Error('[llm] messages 数组为空，无法调用 LLM');
    }
    if (this._isAnthropicProvider()) {
      return this._callAnthropic(messages, temperature, opts);
    }
    return this._callOpenAI(messages, temperature, opts);
  }

  // ═══════════════════════════════════════════════════════════
  // OpenAI 兼容格式
  // ═══════════════════════════════════════════════════════════

  async _callOpenAI(messages, temperature, opts) {
    let finalMessages = messages;
    const images = opts.images || [];
    if (images.length > 0 && this._supportsVision()) {
      finalMessages = this._injectImagesOpenAI(messages, images);
    } else if (images.length > 0 && !this._supportsVision()) {
      console.error(`[llm] 当前模型 ${this.model} 不支持视觉，跳过 ${images.length} 张截图`);
    }

    const headers = { 'Content-Type': 'application/json' };
    if (this._isMimoProvider()) {
      headers['api-key'] = this.apiKey;
    } else {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const tokenParam = this._isMimoProvider()
      ? { max_completion_tokens: this.maxTokens }
      : { max_tokens: this.maxTokens };

    const body = {
      model: this.model,
      messages: finalMessages,
      temperature,
      ...tokenParam,
    };

    return this._fetchWithRetry(`${this.baseUrl}/chat/completions`, headers, body,
      (data) => data.choices?.[0]?.message?.content || '');
  }

  // ═══════════════════════════════════════════════════════════
  // Anthropic 原生格式 (Messages API)
  // ═══════════════════════════════════════════════════════════

  async _callAnthropic(messages, temperature, opts) {
    // 提取 system 消息（Anthropic 要求 system 放在顶层）
    const systemMsgs = messages.filter(m => m.role === 'system');
    const systemPrompt = systemMsgs.map(m => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) return m.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      return '';
    }).join('\n\n') || undefined;

    const conversationMsgs = messages.filter(m => m.role !== 'system');

    let finalMessages = conversationMsgs;
    const images = opts.images || [];
    if (images.length > 0 && this._supportsVision()) {
      finalMessages = this._injectImagesAnthropic(conversationMsgs, images);
    }

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };

    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: finalMessages,
      temperature,
    };
    if (systemPrompt) body.system = systemPrompt;

    return this._fetchWithRetry(`${this.baseUrl}/messages`, headers, body,
      (data) => {
        const content = data.content || [];
        return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      });
  }

  _injectImagesAnthropic(messages, images) {
    return messages.map(m => {
      if (m.role !== 'user' || Array.isArray(m.content)) return m;
      const content = [{ type: 'text', text: m.content }];
      for (const img of images.slice(0, 3)) {
        content.push({
          type: 'image',
          source: { type: 'url', url: img.url || img },
        });
      }
      return { ...m, content };
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 通用 HTTP 请求 + 重试 + Token 追踪
  // ═══════════════════════════════════════════════════════════

  async _fetchWithRetry(url, headers, body, extractContent) {
    const startTime = Date.now();
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!resp.ok) {
          const err = await resp.text();
          throw new Error(`LLM API 请求失败 (HTTP ${resp.status}) — ${err.substring(0, 100)}`);
        }

        const data = await resp.json();
        if (data && data.error) {
          const errMsg = data.error.message || data.error.type || JSON.stringify(data.error);
          throw new Error(`LLM API error: ${errMsg}`);
        }

        const content = extractContent(data);

        // Token 用量追踪（异步写入，不阻塞主流程）
        this._trackUsage(data, body, Date.now() - startTime);

        return content;
      } catch (e) {
        lastError = e;
        const isTransient = lastError.message?.includes('fetch failed')
          || lastError.message?.includes('abort')
          || lastError.message?.includes('timeout')
          || /HTTP 5\d\d/.test(lastError.message);
        if (attempt < this.maxRetries && isTransient) {
          const delay = Math.min(1000 * Math.pow(2, attempt) * (0.5 + Math.random()), 30000);
          console.error(`[llm] 重试 ${attempt}/${this.maxRetries} (${Math.round(delay)}ms): ${e.message}`);
          await new Promise(r => setTimeout(r, delay));
        } else if (attempt < this.maxRetries && !isTransient) {
          break;
        }
      }
    }
    throw lastError;
  }

  /** Token 用量追踪（兼容 OpenAI 和 Anthropic 格式） */
  _trackUsage(data, requestBody, durationMs) {
    try {
      const usage = data?.usage || {};
      const promptTokens = usage.prompt_tokens || usage.input_tokens || 0;
      const completionTokens = usage.completion_tokens || usage.output_tokens || 0;
      const totalTokens = usage.total_tokens || (promptTokens + completionTokens) || 0;
      if (!promptTokens && !completionTokens) return;

      let llmUsage;
      try { llmUsage = require('./memory/llm-usage'); } catch (_) { return; }
      llmUsage.log({
        ts: Date.now(),
        model: this.model,
        awemeId: this._currentAwemeId || null,
        purpose: this._currentPurpose || null,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs,
      });
    } catch (_) {}
  }

  /**
   * 设置当前调用上下文（awemeId/purpose），用于用量追踪。
   */
  setCallContext(awemeId, purpose) {
    this._currentAwemeId = awemeId;
    this._currentPurpose = purpose;
  }

  /**
   * 从 LLM 响应中提取 JSON（三级容错）
   * 1. 直接解析
   * 2. 提取 ```json``` 代码块
   * 3. 提取首个 [] 或 {} 边界
   */
  _extractJSON(text) {
    try { return JSON.parse(text); } catch {}

    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) { try { return JSON.parse(m[1]); } catch {} }

    const ai = text.indexOf('[');
    const oi = text.indexOf('{');
    if (ai >= 0 && (oi < 0 || ai < oi)) {
      const li = text.lastIndexOf(']');
      if (li > ai) { try { return JSON.parse(text.substring(ai, li + 1)); } catch {} }
    }
    if (oi >= 0) {
      const ci = text.lastIndexOf('}');
      if (ci > oi) { try { return JSON.parse(text.substring(oi, ci + 1)); } catch {} }
    }

    throw new Error(`无法从 LLM 响应中提取 JSON: ${text.substring(0, 200)}`);
  }

  /**
   * 分批分析评论（每批最多 BATCH_SIZE 条）
   * 设计意图：防止单次 prompt 过长导致 token 超限或质量下降
   *
   * @param {Array} comments - 评论列表 [{ cid, text }]
   * @param {object} strategy - 策略配置 { style }
   * @returns {Promise<Array>} 分析结果 [{ cid, sentiment, category, priority, summary }]
   */
  async analyzeComments(comments, strategy = {}) {
    const batches = [];
    for (let i = 0; i < comments.length; i += BATCH_SIZE) {
      batches.push(comments.slice(i, i + BATCH_SIZE));
    }

    if (batches.length > 1) {
      console.error(`[llm] 评论 ${comments.length} 条，分 ${batches.length} 批处理`);
    }

    const allResults = [];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      if (batches.length > 1) {
        console.error(`[llm] 处理第 ${i + 1}/${batches.length} 批 (${batch.length} 条)...`);
      }

      const sanitized = batch.map(c => ({ cid: c.cid, text: sanitizeComment(c.text) }));

      const prompt = `你是抖音评论分析师。根据策略风格分析每条评论。

策略风格：${strategy.style || '自然亲切'}

返回 JSON 数组。对每条评论：
- cid: 评论ID（原样）
- sentiment: "positive"|"negative"|"neutral"
- category: "question"|"praise"|"complaint"|"spam"|"other"
- priority: 1-5（5=必须回复）
- summary: 一句话中文摘要

评论列表：${JSON.stringify(sanitized)}

严格返回 JSON 数组，不要其他文字。`;

      const response = await this._call([
        { role: 'system', content: '你是一个专业的抖音评论分析师，只输出 JSON。' },
        { role: 'user', content: prompt },
      ]);

      const batchResults = this._extractJSON(response);
      if (Array.isArray(batchResults)) allResults.push(...batchResults);
    }

    return allResults;
  }

  /**
   * 分批生成回复建议
   * 设计意图：评论文本经消毒后注入 prompt，防止恶意内容影响生成
   *
   * @param {Array} comments - 需回复的评论 [{ cid, text, userTags? }]
   * @param {string|object} strategy - 策略文本或对象
   * @param {string} videoDesc - 视频描述
   * @param {object} [context] - v3 P3 注入的历史上下文
   * @param {Array<{srcText, replyText}>} [context.corpus] - 最近成功语料 few-shot
   * @param {Array<{signature, hitCount, exampleText, mitigation}>} [context.failures] - 避雷清单
   * @param {Array<string>} [context.avoid] - 不得复用的回复文本（reply_hash 命中过的）
   * @param {object} [context.repoFacts] - 推广仓库真实事实（由 repo-info 命令缓存）；注入后 LLM 必须基于此生成，禁止编造
   * @returns {Promise<Array>} 回复建议 [{ cid, reply }]
   */
  async suggestReplies(comments, strategy, videoDesc, context = {}, persona = null) {
    const strategyText = typeof strategy === 'string' ? strategy : (strategy?.style || '自然亲切');

    const batches = [];
    for (let i = 0; i < comments.length; i += BATCH_SIZE) {
      batches.push(comments.slice(i, i + BATCH_SIZE));
    }

    if (batches.length > 1) {
      console.error(`[llm] 评论 ${comments.length} 条，分 ${batches.length} 批生成回复`);
    }

    // ── 历史上下文片段（出现在每个 batch 的 prompt 头部，token 预算内）──
    const corpus = Array.isArray(context.corpus) ? context.corpus.slice(0, 20) : [];
    const failurePatterns = Array.isArray(context.failures) ? context.failures.slice(0, 10) : [];
    const avoidList = Array.isArray(context.avoid) ? context.avoid.slice(0, 30) : [];
    const repoFacts = context.repoFacts || null;

    const corpusBlock = corpus.length === 0 ? '' :
      `\n## 历史成功回复（few-shot，参考语气和切入角度，不要原句复制）：\n` +
      corpus.map((c, i) => {
        const src = sanitizeComment(c.srcText || '', 80);
        const rep = sanitizeComment(c.replyText || '', 80);
        return `${i + 1}. 用户:「${src}」 → 我们回:「${rep}」`;
      }).join('\n') + '\n';

    const failureBlock = failurePatterns.length === 0 ? '' :
      `\n## 历史失败模式（避免触发，hit_count=触发次数）：\n` +
      failurePatterns.map((f, i) => {
        const ex = sanitizeComment(f.exampleText || '', 60);
        const mit = f.mitigation ? `（缓解: ${f.mitigation}）` : '';
        return `${i + 1}. ${f.signature} × ${f.hitCount}${mit}${ex ? ` 例: 「${ex}」` : ''}`;
      }).join('\n') + '\n';

    const avoidBlock = avoidList.length === 0 ? '' :
      `\n## 严禁复用（这些原文已发过，必须重新组织措辞）：\n` +
      avoidList.map((t, i) => `${i + 1}. ${sanitizeComment(t, 80)}`).join('\n') + '\n';

    const repoFactsBlock = !repoFacts ? '' :
      `\n## 推广仓库真实事实（仅当评论与该仓库相关时使用；禁止编造未列出的 star 数/功能名/版本号）：\n` +
      `- 仓库：${repoFacts.full_name}\n` +
      `- 描述：${repoFacts.description || '无'}\n` +
      `- star 数：${repoFacts.stars}\n` +
      `- 主语言：${repoFacts.primary_language || '未知'}\n` +
      `- 最近 push：${repoFacts.pushed_at || '未知'}\n` +
      (repoFacts.latest_release ? `- 最近 release：${repoFacts.latest_release.tag}（${repoFacts.latest_release.published_at}）\n` : '') +
      `若提及具体数字/功能，必须来自上方；无相关事实则不写具体数字。\n`;

    // ── 人格化 system prompt ──
    const { buildSystemPrompt, buildUserPrefix, getTemperature } = require('./personas');
    const systemPrompt = persona
      ? buildSystemPrompt(persona, strategyText)
      : `你是抖音运营助手，只输出 JSON 回复建议。策略风格：${strategyText}`;
    const userPrefix = persona ? buildUserPrefix(persona) : '';
    const temperature = persona ? getTemperature(persona) : 0.7;

    const allResults = [];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      if (batches.length > 1) {
        console.error(`[llm] 处理第 ${i + 1}/${batches.length} 批 (${batch.length} 条)...`);
      }

      const sanitized = batch.map(c => ({
        cid: c.cid,
        text: sanitizeComment(c.text),
        ...(Array.isArray(c.userTags) && c.userTags.length ? { user_tags: c.userTags.slice(0, 5) } : {}),
      }));

      const prompt = `为以下抖音评论生成回复建议。

策略风格：${strategyText}
视频描述：${videoDesc || '暂无'}
${corpusBlock}${failureBlock}${avoidBlock}${repoFactsBlock}
## 回复策略：按评论类型选择

A. 提问型（问链接/问方法/问地点/问效果/问价格）
→ 直接回答，不要绕弯；视频里有就回答+补充细节；视频里没有就说"回头整理/下次分享"，不编造
→ 回答完可追问一句增加互动

B. 赞美型（好看/厉害/喜欢/绝了/学到了）
→ 感谢要具体，不要只说"谢谢"；反问相关问题延续对话
→ 避免"谢谢夸奖""感谢喜欢"（太正式）

C. 讨论型（观点/经验分享/补充/不同意见）
→ 先认同（"说得对""确实"）再补充自己的观点
→ 不同意见用委婉表达（"我觉得...""也有可能..."），不抬杠

D. 简短型（表情/单字/马住/蹲/学习了）
→ 简短回应，匹配对方能量；不对简短评论写长篇

E. 艾特型（@朋友来看）
→ 欢迎被艾特来的朋友，语气轻松

F. 批评/质疑型
→ 保持友好，先理解对方的点，不争辩

## 语言规则
- 口语化——像微信聊天，不像写邮件；短句为主，允许不完整句
- 偶尔 emoji（1-3个），不要每句都有
- 不说"希望对你有所帮助""祝生活愉快"等客服话术
- 不在回复里主动提"关注""主页""其他视频"（除非对方问）

## 风格多样化（强制要求）
⚠️ 本批次共 ${sanitized.length} 条回复，必须使用至少 3 种不同语气/风格：
- 有的热情活泼、多用口语感叹
- 有的简洁干脆、一两句话就说清楚
- 有的温暖细腻、分享经验（但不要条条都"我之前也..."）
- 偶尔有极简回复（3-8字）
- 绝不允许所有回复都是同一风格

## 接地要求（必须遵守，优先级高于风格）
- 每条回复必须针对该用户原话（user_text）中的具体问题/细节/措辞作答
- 若评论提问，必须正面回答；不得顾左右而言他或泛泛套话
- 不得编造视频或评论未提及的信息（价格、地点、效果、型号等）
- 宁可简短且针对，不要长而空洞

返回 JSON 数组：
- cid: 评论ID
- reply: 建议回复（基于 user_text 原话作答；符合策略风格；不要原句复制历史回复；不要触发失败模式；不要复读"严禁复用"清单；提及仓库时必须用 repoFacts 的真实数字/功能，不得编造）
- 不需要回复的评论不要包含
${userPrefix}
需回复的评论（user_text 为用户原话，必须基于它生成回复；user_tags 表示该用户的画像标签，可酌情个性化）：${JSON.stringify(sanitized)}

严格返回 JSON 数组。`;

      const response = await this._call([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ], temperature);

      const batchResults = this._extractJSON(response);
      if (Array.isArray(batchResults)) allResults.push(...batchResults);
    }

    return allResults;
  }

  /**
   * 分批分析评论（多模态版）— 支持 prompt-builder 预构建的 prompt + 截图注入
   *
   * 调用方式 1（推荐，prompt-builder 预构建）：
   *   client.analyzeCommentsMultiModal({ systemPrompt, userPrompt, images })
   *
   * 调用方式 2（向后兼容，自动构建 prompt）：
   *   client.analyzeCommentsMultiModal({ comments, images, strategy })
   *
   * @param {object} opts
   * @param {string} [opts.systemPrompt]
   * @param {string} [opts.userPrompt]   - 预构建的 user prompt（含评论列表）
   * @param {Array}  [opts.comments]     - 原始评论列表（当 userPrompt 未提供时使用）
   * @param {string[]} [opts.images]
   * @param {string|object} [opts.strategy]
   * @returns {Promise<Array>}
   */
  async analyzeCommentsMultiModal(opts = {}) {
    const { systemPrompt = '', userPrompt = '', comments = [], images = [], strategy = '' } = opts;
    const strategyText = typeof strategy === 'string' ? strategy : (strategy?.style || '自然亲切');

    // 方式 1：预构建的 userPrompt → 直接调用（不分批）
    if (userPrompt) {
      const response = await this._call([
        { role: 'system', content: systemPrompt || `你是一个专业的抖音评论分析师，只输出 JSON。策略风格：${strategyText}` },
        { role: 'user', content: userPrompt },
      ], 0.3, { images });
      const results = this._extractJSON(response);
      return Array.isArray(results) ? results : [];
    }

    // 方式 2：用 comments 参数自动构建 prompt
    if (!comments || comments.length === 0) return [];

    const batches = [];
    for (let i = 0; i < comments.length; i += BATCH_SIZE) {
      batches.push(comments.slice(i, i + BATCH_SIZE));
    }

    if (batches.length > 1) {
      console.error(`[llm] 评论 ${comments.length} 条，分 ${batches.length} 批处理（多模态）`);
    }

    const allResults = [];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const sp = systemPrompt || `你是一个专业的抖音评论分析师，只输出 JSON。策略风格：${strategyText}`;
      const sanitized = batch.map(c => ({ cid: c.cid, text: sanitizeComment(c.text) }));
      const up = `你是抖音评论分析师。根据视频上下文分析每条评论。

策略风格：${strategyText}

返回 JSON 数组。对每条评论：
- cid: 评论ID（原样）
- sentiment: "positive"|"negative"|"neutral"
- category: "question"|"praise"|"complaint"|"spam"|"other"
- priority: 1-5（5=必须回复）
- summary: 一句话中文摘要

评论列表：${JSON.stringify(sanitized)}

严格返回 JSON 数组，不要其他文字。`;

      const response = await this._call([
        { role: 'system', content: sp },
        { role: 'user', content: up },
      ], 0.3, { images });

      const batchResults = this._extractJSON(response);
      if (Array.isArray(batchResults)) allResults.push(...batchResults);
    }

    return allResults;
  }

  /**
   * 分批生成回复建议（多模态版）— 支持 prompt-builder 预构建的 prompt + 截图注入
   *
   * @param {object} promptData - { systemPrompt, userPrompt, images, temperature }
   * @returns {Promise<Array>} [{ cid, reply }]
   */
  async suggestRepliesMultiModal(promptData) {
    if (!promptData || !promptData.userPrompt) {
      throw new Error('[llm] suggestRepliesMultiModal 需要 promptData: { systemPrompt, userPrompt, images }');
    }

    const { systemPrompt, userPrompt, images } = promptData;
    const temperature = promptData.temperature || 0.7;

    const response = await this._call([
      { role: 'system', content: systemPrompt || '你是一个抖音运营助手，只输出 JSON 回复建议。' },
      { role: 'user', content: userPrompt },
    ], temperature, { images });

    const results = this._extractJSON(response);
    return Array.isArray(results) ? results : [];
  }

  /**
   * 单条回复重写（用于 dedup 命中后再生成一次，强制切换人格）。
   */
  async rewriteReply(srcText, originalReply, strategy, videoDesc, excludePersona = null) {
    const strategyText = typeof strategy === 'string' ? strategy : (strategy?.style || '自然亲切');

    // 强制切换人格，确保重写后的回复风格完全不同
    const { pickPersona, buildSystemPrompt, getTemperature } = require('./personas');
    const persona = pickPersona({ excludeId: excludePersona?.id });
    const systemPrompt = buildSystemPrompt(persona, strategyText);
    const temperature = getTemperature(persona);

    const prompt = `你之前给评论「${sanitizeComment(srcText || '', 80)}」生成的回复是「${sanitizeComment(originalReply || '', 80)}」，但这句话我们已经发过了。请用完全不同的角度/措辞重写一遍。

策略风格：${strategyText}
视频描述：${videoDesc || '暂无'}

仅返回新的回复文本，不要任何前缀、引号或解释。`;
    const response = await this._call([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ], temperature);
    return String(response || '').trim().replace(/^["「'']|["」'']$/g, '');
  }
}

module.exports = { LLMClient, sanitizeComment };
