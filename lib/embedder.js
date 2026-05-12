/**
 * lib/embedder.js
 *
 * 嵌入模型抽象层。
 *
 * 当前实现：Ollama Embeddings API（兼容 OpenAI /v1/embeddings 格式）。
 * 可通过 config 配置 endpoint 和 model。
 *
 * 核心原则：
 * - 本地优先：默认使用本地 Ollama 服务，不依赖外部 API
 * - 可配置：支持切换任意兼容的嵌入 API
 * - 优雅降级：批量嵌入失败时逐个重试，文本超长时自动截断
 */
export class Embedder {
  #endpoint;
  #model;
  #log;
  #cache;
  #cacheMax;

  /**
   * @param {object} opts
   * @param {string} opts.endpoint
   * @param {string} opts.model
   * @param {object} opts.log
   * @param {number} [opts.cacheSize=20] - 查询嵌入缓存大小
   */

  /**
   * @param {object} opts
   * @param {string} opts.endpoint - API 端点（默认 Ollama embed API）
   * @param {string} opts.model   - 嵌入模型名称
   * @param {object} opts.log     - logger
   */
  constructor({ endpoint, model, log, cacheSize = 20 }) {
    this.#endpoint = endpoint || "http://localhost:11434/api/embed";
    this.#model = model || "qwen3-embedding:0.6b";
    this.#log = log;
    this.#cache = new Map();
    this.#cacheMax = cacheSize;
  }

  get model() {
    return this.#model;
  }

  get endpoint() {
    return this.#endpoint;
  }

  /**
   * 更新配置（运行时切换端点或模型）
   */
  reconfigure({ endpoint, model } = {}) {
    if (endpoint) this.#endpoint = endpoint;
    if (model) this.#model = model;
    this.#log?.info(`embedder reconfigured: endpoint=${this.#endpoint}, model=${this.#model}`);
  }

  /**
   * 根据模型类型估算最大安全字符数（保守估计）
   * qwen3-embedding:0.6b 上下文窗口 8192 tokens
   * all-minilm 等小模型上下文窗口通常为 256 tokens
   * nomic-embed-text 上下文窗口为 8192 tokens
   */
  #maxChars() {
    if (this.#model.includes("all-minilm") || this.#model.includes("mini")) return 150;
    if (this.#model.includes("qwen3-embedding")) return 6000;
    return 1500;
  }

  /**
   * 获取嵌入模型的上下文窗口大小（以 tokens 估算）
   * 用于 indexer 决定 chunk 大小
   */
  get contextWindow() {
    if (this.#model.includes("qwen3-embedding")) return 8192;
    if (this.#model.includes("nomic-embed-text")) return 8192;
    if (this.#model.includes("all-minilm") || this.#model.includes("mini")) return 256;
    return 2048;
  }

  #truncate(text) {
    if (!text) return "";
    const maxChars = this.#maxChars();
    if (text.length > maxChars) {
      return text.substring(0, maxChars);
    }
    return text;
  }

  /**
   * 测试连接是否可用
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  /** 清空嵌入缓存 */
  clearCache() {
    this.#cache.clear();
  }

  /** 获取缓存统计 */
  getCacheStats() {
    return { size: this.#cache.size, max: this.#cacheMax };
  }

  async healthCheck() {
    try {
      const url = new URL(this.#endpoint);
      const baseUrl = `${url.protocol}//${url.host}`;
      const resp = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        return { ok: false, error: `Ollama 服务响应异常: ${resp.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `无法连接到嵌入服务 (${this.#endpoint}): ${err.message}` };
    }
  }

  /**
   * 对单段文本进行向量化
   * @param {string} text
   * @returns {Promise<number[]>} embedding 向量
   */
  async embed(text) {
    if (!text || text.trim().length === 0) {
      throw new Error("无法对空文本计算嵌入向量");
    }

    const key = text.trim();

    // LRU 缓存命中
    if (this.#cache.has(key)) {
      const val = this.#cache.get(key);
      // 移到末尾（最近使用）
      this.#cache.delete(key);
      this.#cache.set(key, val);
      this.#log?.debug(`cache hit: "${key.substring(0, 40)}..."`);
      return val;
    }

    const body = JSON.stringify({
      model: this.#model,
      input: this.#truncate(key),
    });

    const resp = await fetch(this.#endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "unknown error");
      throw new Error(`嵌入 API 请求失败 (${resp.status}): ${errText.substring(0, 200)}`);
    }

    const data = await resp.json();

    let embedding;

    // Ollama /api/embed 返回格式: { model, embeddings: [[...]] }
    if (data.embeddings && Array.isArray(data.embeddings) && data.embeddings.length > 0) {
      embedding = data.embeddings[0];
    } else if (data.data && Array.isArray(data.data) && data.data.length > 0) {
      // OpenAI /v1/embeddings 格式: { data: [{ embedding: [...] }] }
      embedding = data.data[0].embedding;
    } else {
      throw new Error(`无法解析嵌入 API 响应: ${JSON.stringify(data).substring(0, 200)}`);
    }

    // 写入 LRU 缓存，超过上限时淘汰最久未用的
    if (this.#cache.size >= this.#cacheMax) {
      const firstKey = this.#cache.keys().next().value;
      if (firstKey) this.#cache.delete(firstKey);
    }
    this.#cache.set(key, embedding);

    return embedding;
  }

  /**
   * 批量向量化（Ollama 原生支持）
   * 如果批量请求失败（如某条文本超长），自动降级为逐个嵌入
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async embedBatch(texts) {
    const validTexts = texts
      .filter(t => t && t.trim().length > 0)
      .map(t => this.#truncate(t.trim()));
    if (validTexts.length === 0) return [];

    try {
      const body = JSON.stringify({
        model: this.#model,
        input: validTexts,
      });

      const resp = await fetch(this.#endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(120000),
      });

      if (!resp.ok) {
        this.#log?.warn(`batch embed failed (${resp.status}), falling back to individual`);
        return this.#embedBatchFallback(validTexts);
      }

      const data = await resp.json();

      if (data.embeddings && Array.isArray(data.embeddings)) {
        return data.embeddings;
      }

      if (data.data && Array.isArray(data.data)) {
        return data.data.map(d => d.embedding);
      }

      throw new Error(`无法解析批量嵌入 API 响应`);
    } catch (err) {
      this.#log?.warn(`batch embed error: ${err.message}, falling back to individual`);
      return this.#embedBatchFallback(validTexts);
    }
  }

  /**
   * 逐个嵌入的降级方案
   * 当批量请求失败时（如单条文本超出模型上下文），逐个尝试
   * 确保返回数组长度与输入一致（失败项用该模型首个有效向量填充）
   */
  async #embedBatchFallback(texts) {
    const results = new Array(texts.length).fill(null);

    for (let i = 0; i < texts.length; i++) {
      try {
        const emb = await this.embed(texts[i]);
        results[i] = emb;
      } catch (err) {
        this.#log?.warn(`individual embed failed for text (${texts[i].length} chars): ${err.message}`);
        if (err.message.includes("input length exceeds") || err.message.includes("context length")) {
          try {
            const shortText = texts[i].substring(0, 500);
            const emb = await this.embed(shortText);
            results[i] = emb;
          } catch (err2) {
            this.#log?.warn(`shortened embed also failed: ${err2.message}`);
          }
        }
      }
    }
    return results;
  }
}

/**
 * 计算向量的 L2 模长
 * @param {number[]|Float32Array} vec
 * @returns {number}
 */
export function computeNorm(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  return Math.sqrt(sum);
}

/**
 * 计算两个向量的余弦相似度
 * @param {number[]|Float32Array} a
 * @param {number[]|Float32Array} b
 * @param {number} [normA] - 预计算的 ||a||，省略则实时计算
 * @param {number} [normB] - 预计算的 ||b||，省略则实时计算
 * @returns {number} 0-1 之间的相似度
 */
export function cosineSimilarity(a, b, normA, normB) {
  if (a.length !== b.length) {
    throw new Error(`向量维度不匹配: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];

  if (normA === undefined) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    normA = Math.sqrt(s);
  }
  if (normB === undefined) {
    let s = 0;
    for (let i = 0; i < b.length; i++) s += b[i] * b[i];
    normB = Math.sqrt(s);
  }

  const magnitude = normA * normB;
  if (magnitude === 0) return 0;

  return dot / magnitude;
}
