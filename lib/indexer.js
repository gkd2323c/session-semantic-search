/**
 * lib/indexer.js
 *
 * 会话索引器：扫描 session .jsonl 文件 → 分片 → 向量化 → 存入向量存储。
 *
 * 分片策略：滑动窗口方式将长对话切成 N 轮一段的重叠片段，
 * 保证每个片段有足够的上下文且边界平滑。
 */
import fsp from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

const INDEX_VERSION = 1;

export class SessionIndexer {
  #sessionsDir;
  #store;
  #embedder;
  #log;
  #chunkSize;
  #chunkOverlap;
  #indexMetaPath;
  #indexMeta;

  /**
   * @param {object} opts
   * @param {string}   opts.sessionsDir  - ~/.hanako/agents/hanako/sessions/
   * @param {VectorStore} opts.store     - 向量存储实例
   * @param {Embedder}    opts.embedder  - 嵌入器实例
   * @param {object}      opts.log       - logger
   * @param {number}      opts.chunkSize    - 每段对话轮数（默认 10）
   * @param {number}      opts.chunkOverlap - 重叠轮数（默认 2）
   */
  constructor({ sessionsDir, store, embedder, log, chunkSize = 10, chunkOverlap = 2 }) {
    this.#sessionsDir = sessionsDir;
    this.#store = store;
    this.#embedder = embedder;
    this.#log = log;
    this.#chunkSize = chunkSize;
    this.#chunkOverlap = chunkOverlap;
    this.#indexMetaPath = path.join(sessionsDir, "..", "memory", "semantic-index-meta.json");
    this.#indexMeta = null;
  }

  /** 加载或初始化索引元信息 */
  async #loadMeta() {
    try {
      const raw = await fsp.readFile(this.#indexMetaPath, "utf-8");
      this.#indexMeta = JSON.parse(raw);
    } catch {
      this.#indexMeta = {
        version: INDEX_VERSION,
        indexedFiles: {},  // { relativePath: { mtimeMs, size, chunkCount } }
        lastFullScan: null,
        lastIncrementalScan: null,
      };
    }
  }

  async #saveMeta() {
    await fsp.mkdir(path.dirname(this.#indexMetaPath), { recursive: true });
    await fsp.writeFile(this.#indexMetaPath, JSON.stringify(this.#indexMeta, null, 2), "utf-8");
  }

  /**
   * 全量扫描：索引所有 .jsonl 文件
   */
  async scanAll({ force } = {}) {
    await this.#loadMeta();
    this.#log?.info("starting full scan of sessions...");

    const files = await this.#collectJsonlFiles();
    this.#log?.info(`found ${files.length} session files`);

    let indexed = 0;
    let skipped = 0;

    for (const filePath of files) {
      const relPath = path.relative(this.#sessionsDir, filePath);
      const stat = await fsp.stat(filePath);
      const known = this.#indexMeta.indexedFiles[relPath];

      // 如果文件未变更且不强制重新索引，跳过
      if (!force && known && known.mtimeMs === stat.mtimeMs) {
        skipped++;
        continue;
      }

      // 移除旧的索引条目（如果存在）
      this.#store.removeSession(relPath);

      // 解析并索引
      const chunks = await this.#parseAndChunk(filePath);
      if (chunks.length > 0) {
        await this.#embedAndStore(chunks, relPath);
        this.#indexMeta.indexedFiles[relPath] = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          chunkCount: chunks.length,
          indexedAt: new Date().toISOString(),
        };
        indexed++;
        this.#log?.info(`  indexed: ${relPath} → ${chunks.length} chunks`);
      } else {
        this.#indexMeta.indexedFiles[relPath] = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          chunkCount: 0,
          indexedAt: new Date().toISOString(),
        };
        skipped++;
      }
    }

    this.#indexMeta.lastFullScan = new Date().toISOString();
    await this.#saveMeta();
    await this.#store.save();

    this.#log?.info(`scan complete: ${indexed} indexed, ${skipped} skipped/empty`);
    return { indexed, skipped, total: files.length };
  }

  /**
   * 增量扫描：仅处理新增或变更的文件
   */
  async scanIncremental() {
    await this.#loadMeta();
    this.#log?.info("starting incremental scan...");

    const files = await this.#collectJsonlFiles();
    let indexed = 0;
    let skipped = 0;

    for (const filePath of files) {
      const relPath = path.relative(this.#sessionsDir, filePath);
      const stat = await fsp.stat(filePath);
      const known = this.#indexMeta.indexedFiles[relPath];

      if (known && known.mtimeMs === stat.mtimeMs) {
        skipped++;
        continue;
      }

      this.#store.removeSession(relPath);
      const chunks = await this.#parseAndChunk(filePath);
      if (chunks.length > 0) {
        await this.#embedAndStore(chunks, relPath);
        this.#indexMeta.indexedFiles[relPath] = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          chunkCount: chunks.length,
          indexedAt: new Date().toISOString(),
        };
        indexed++;
        this.#log?.info(`  incremental: ${relPath} → ${chunks.length} chunks`);
      } else {
        this.#indexMeta.indexedFiles[relPath] = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          chunkCount: 0,
          indexedAt: new Date().toISOString(),
        };
        skipped++;
      }
    }

    this.#indexMeta.lastIncrementalScan = new Date().toISOString();
    await this.#saveMeta();
    await this.#store.save();

    this.#log?.info(`incremental scan: ${indexed} indexed, ${skipped} unchanged`);
    return { indexed, skipped, total: files.length };
  }

  /**
   * 索引单个 session 文件（手动触发时使用）
   */
  async indexFile(sessionId) {
    // 尝试在 sessions 目录和 archived 子目录下查找
    const candidates = [
      path.join(this.#sessionsDir, `${sessionId}.jsonl`),
      path.join(this.#sessionsDir, sessionId),
      path.join(this.#sessionsDir, "archived", `${sessionId}.jsonl`),
      path.join(this.#sessionsDir, "archived", sessionId),
    ];

    let filePath = null;
    for (const cp of candidates) {
      if (existsSync(cp)) { filePath = cp; break; }
    }

    if (!filePath) {
      throw new Error(`Session 文件未找到: ${sessionId}`);
    }

    const relPath = path.relative(this.#sessionsDir, filePath);
    const stat = await fsp.stat(filePath);

    this.#store.removeSession(relPath);
    const chunks = await this.#parseAndChunk(filePath);
    if (chunks.length > 0) {
      await this.#embedAndStore(chunks, relPath);
    }

    if (!this.#indexMeta) await this.#loadMeta();
    this.#indexMeta.indexedFiles[relPath] = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      chunkCount: chunks.length,
      indexedAt: new Date().toISOString(),
    };
    await this.#saveMeta();
    await this.#store.save();

    return { sessionId: relPath, chunks: chunks.length };
  }

  // ── 内部：收集所有 .jsonl 文件 ──────────────────────────────

  async #collectJsonlFiles() {
    const results = [];

    async function walk(dir) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "bridge" || entry.name === "channel-temp") continue;
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          results.push(full);
        }
      }
    }

    await walk(this.#sessionsDir);
    return results;
  }

  // ── 内部：解析 jsonl 并切片 ─────────────────────────────────

  async #parseAndChunk(filePath) {
    const exchanges = await this.#parseExchanges(filePath);
    if (exchanges.length === 0) return [];

    return this.#chunkExchanges(exchanges);
  }

  /**
   * 解析 .jsonl 文件，提取对话轮次
   * 返回: [{ role, text, timestamp }]
   */
  async #parseExchanges(filePath) {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    const exchanges = [];
    let sessionTimestamp = null;

    for await (const line of rl) {
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }

      switch (evt.type) {
        case "session": {
          sessionTimestamp = evt.timestamp;
          break;
        }
        case "message": {
          const msg = evt.message;
          if (!msg) break;

          const text = this.#extractConversationText(msg.content);
          if (!text) continue;

          exchanges.push({
            role: msg.role || "unknown",
            text,
            timestamp: evt.timestamp || sessionTimestamp,
          });
          break;
        }
        case "thinking_level_change":
        case "model_change":
          // 忽略系统变更事件
          break;
      }
    }

    // 如果没有任何对话内容，但至少有一个 session 事件，返回一个占位
    if (exchanges.length === 0 && sessionTimestamp) {
      exchanges.push({
        role: "system",
        text: "(空会话，无对话内容)",
        timestamp: sessionTimestamp,
      });
    }

    return exchanges;
  }

  /**
   * 从 message.content 数组中提取人类可读的对话文本
   * 跳过 thinking 和 toolCall 等非对话内容
   */
  #extractConversationText(content) {
    if (!Array.isArray(content)) {
      // 可能直接是字符串
      if (typeof content === "string") return content.trim();
      return "";
    }

    const parts = content
      .filter((c) => c.type === "text" && !c.thinking && !c.thinkingSignature)
      .map((c) => c.text)
      .filter(Boolean);

    if (parts.length === 0) return "";

    return parts.join("\n").trim();
  }

  /**
   * 将对话轮次列表切成重叠片段
   * 滑动窗口：每 #chunkSize 轮一段，每段重叠 #chunkOverlap 轮
   */
  #chunkExchanges(exchanges) {
    if (exchanges.length === 0) return [];

    const chunks = [];
    const step = this.#chunkSize - this.#chunkOverlap;

    // 如果总轮数少于 chunkSize，直接作为一段
    if (step <= 0 || exchanges.length <= this.#chunkSize) {
      chunks.push({
        text: this.#formatExchangeChunk(exchanges),
        exchangeRange: [0, exchanges.length - 1],
        timestamp: exchanges[0].timestamp,
      });
      return chunks;
    }

    for (let start = 0; start < exchanges.length; start += step) {
      const end = Math.min(start + this.#chunkSize, exchanges.length);
      const slice = exchanges.slice(start, end);
      chunks.push({
        text: this.#formatExchangeChunk(slice),
        exchangeRange: [start, end - 1],
        timestamp: slice[0].timestamp,
      });
      if (end >= exchanges.length) break;
    }

    return chunks;
  }

  /**
   * 将一组对话轮次格式化为可读文本
   */
  #formatExchangeChunk(exchanges) {
    return exchanges
      .map((ex) => {
        const roleLabel =
          ex.role === "user" ? "👤 用户" :
          ex.role === "assistant" ? "🤖 Hanako" :
          ex.role === "system" ? "⚙️ 系统" : `🔧 ${ex.role}`;
        return `${roleLabel}: ${ex.text}`;
      })
      .join("\n\n");
  }

  // ── 内部：批量向量化并存储 ──────────────────────────────────

  async #embedAndStore(chunks, sessionId) {
    const texts = chunks.map(c => c.text.substring(0, 3000)); // 限制长度

    // 批量嵌入
    const embeddings = await this.#embedder.embedBatch(texts);

    // 提取会话元信息
    const timestamp = chunks[0]?.timestamp || new Date().toISOString();
    const title = timestamp.substring(0, 10); // 用日期作为 fallback 标题

    // 提取用户话题词（从第一段获取）
    const userTopics = this.#extractUserTopics(chunks);

    // 存储
    const entries = chunks.map((chunk, i) => ({
      sessionId,
      chunkIndex: i,
      text: chunk.text.substring(0, 3000),
      embedding: embeddings[i],
      timestamp,
      metadata: {
        title,
        exchangeRange: chunk.exchangeRange,
        userTopics,
        chunkSize: this.#chunkSize,
      },
    }));

    this.#store.addEntries(entries);
  }

  /**
   * 从片段中提取用户话题关键词
   */
  #extractUserTopics(chunks) {
    const stopWords = new Set([
      "的", "了", "是", "在", "有", "和", "就", "不", "也", "都",
      "这", "那", "你", "我", "他", "她", "它", "们", "什么", "怎么",
      "为什么", "如何", "能", "吗", "吧", "啊", "呢", "一个", "没有",
      "可以", "这个", "那个", "把", "被", "让", "给", "对", "到", "从",
      "a", "an", "the", "is", "are", "was", "were", "to", "in", "of",
      "for", "with", "on", "at", "by", "do", "does", "did", "have",
    ]);

    const freq = new Map();
    for (const chunk of chunks) {
      // 只从用户消息中提取
      const userParts = chunk.text.split("\n").filter(l => l.startsWith("👤 用户"));
      for (const line of userParts) {
        const tokens = line.match(/[\w\u4e00-\u9fff]+/g) || [];
        for (const token of tokens) {
          const lower = token.toLowerCase();
          if (stopWords.has(lower) || token.length < 2) continue;
          freq.set(token, (freq.get(token) || 0) + 1);
        }
      }
    }

    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([word]) => word);
  }

  /**
   * 获取索引元信息
   */
  async getMeta() {
    if (!this.#indexMeta) await this.#loadMeta();
    return this.#indexMeta;
  }
}
