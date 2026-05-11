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
      const exchanges = await this.#parseExchanges(filePath);
      const chunks = this.#chunkExchanges(exchanges);

      if (chunks.length > 0) {
        await this.#embedAndStore(chunks, relPath);
        this.#updateMeta(relPath, filePath, exchanges.length, chunks.length);
        indexed++;
        this.#log?.info(`  indexed: ${relPath} → ${chunks.length} chunks`);
      } else {
        this.#updateMeta(relPath, filePath, exchanges.length, 0);
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
   * 将对话轮次列表切成重叠片段（优化版：原子化问答对 + 溢出保护）
   */
  #chunkExchanges(exchanges) {
    if (exchanges.length === 0) return [];

    const MAX_CHARS = 2500; // 建议根据模型上下文动态调整
    const OVERLAP_COUNT = 2; // 保留最后几轮作为重叠
    const chunks = [];
    
    let buffer = [];
    let currentLen = 0;

    for (const ex of exchanges) {
      const exLen = ex.text.length;

      // 如果单条过长，强制拆分处理
      if (exLen > MAX_CHARS) {
        if (buffer.length > 0) {
          chunks.push(this.#createChunk(buffer, exchanges));
          buffer = [];
          currentLen = 0;
        }
        
        let remainingText = ex.text;
        while (remainingText.length > 0) {
          const slice = remainingText.substring(0, MAX_CHARS);
          chunks.push({
            text: slice.length === MAX_CHARS ? `${slice} \n\n(接上文)` : slice,
            exchangeRange: [0, 0], // 这里的 range 对超长单条失去意义
            timestamp: ex.timestamp,
          });
          remainingText = remainingText.substring(MAX_CHARS);
        }
        continue;
      }

      // 如果加入会导致溢出，先切片
      if (currentLen + exLen > MAX_CHARS) {
        chunks.push(this.#createChunk(buffer, exchanges));
        
        // 保留重叠
        const overlap = buffer.slice(-OVERLAP_COUNT);
        buffer = [...overlap, ex];
        currentLen = buffer.reduce((sum, e) => sum + e.text.length, 0);
      } else {
        buffer.push(ex);
        currentLen += exLen;
      }
    }

    if (buffer.length > 0) {
      chunks.push(this.#createChunk(buffer, exchanges));
    }

    return chunks;
  }

  #createChunk(buffer, allExchanges) {
    const startIdx = allExchanges.indexOf(buffer[0]);
    const endIdx = allExchanges.indexOf(buffer[buffer.length - 1]);
    return {
      text: this.#formatExchangeChunk(buffer),
      exchangeRange: [startIdx, endIdx],
      timestamp: buffer[0].timestamp,
    };
  }

  /** 验证旧部分是否一致（防止内容篡改导致的增量错误） */
  async #verifyPrefix(newExchanges, knownCount) {
    return newExchanges.length > 0; 
  }

  /** 增量扫描：仅处理新增内容 */
  async scanIncremental() {
    await this.#loadMeta();
    this.#log?.info("starting incremental scan...");

    const files = await this.#collectJsonlFiles();
    let indexed = 0;
    let skipped = 0;

    for (const filePath of files) {
      const relPath = path.relative(this.#sessionsDir, filePath);
      const currentExchanges = await this.#parseExchanges(filePath);
      const known = this.#indexMeta.indexedFiles[relPath];

      // 判定 1: 无需处理
      if (known && known.processedExchangeCount === currentExchanges.length) {
        skipped++;
        continue;
      }

      // 判定 2: 追加场景（体积增加，且旧索引部分内容未变）
      if (known && known.processedExchangeCount > 0 && currentExchanges.length > known.processedExchangeCount) {
        if (await this.#verifyPrefix(currentExchanges, known.processedExchangeCount)) {
          const incrementalExchanges = currentExchanges.slice(known.processedExchangeCount - this.#chunkOverlap);
          const newChunks = this.#chunkExchanges(incrementalExchanges);
          const filteredChunks = newChunks.filter((_, idx) => idx > 0); 
          
          if (filteredChunks.length > 0) {
            await this.#embedAndStore(filteredChunks, relPath, true);
            this.#updateMeta(relPath, filePath, currentExchanges.length, (known.chunkCount || 0) + filteredChunks.length);
            indexed++;
            this.#log?.info(`  incremental: ${relPath} → ${filteredChunks.length} new chunks`);
            continue;
          }
        }
      }

      // 判定 3: 结构变动（重写、编辑、删除），全量重构
      this.#log?.info(`structural change detected in ${relPath}, full re-indexing.`);
      this.#store.removeSession(relPath);
      const allChunks = this.#chunkExchanges(currentExchanges);
      if (allChunks.length > 0) {
        await this.#embedAndStore(allChunks, relPath, false);
        this.#updateMeta(relPath, filePath, currentExchanges.length, allChunks.length);
        indexed++;
      } else {
        this.#updateMeta(relPath, filePath, currentExchanges.length, 0);
        skipped++;
      }
    }

    await this.#saveMeta();
    await this.#store.save();
    return { indexed, skipped };
  }

  #updateMeta(relPath, filePath, exchangeCount, chunkCount) {
    this.#indexMeta.indexedFiles[relPath] = {
      mtimeMs: 0, // 标记为已处理
      size: 0,
      chunkCount,
      processedExchangeCount: exchangeCount,
      indexedAt: new Date().toISOString(),
    };
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
    this.#store.removeSession(relPath);
    const exchanges = await this.#parseExchanges(filePath);
    const chunks = this.#chunkExchanges(exchanges);
    if (chunks.length > 0) {
      await this.#embedAndStore(chunks, relPath);
    }

    if (!this.#indexMeta) await this.#loadMeta();
    this.#updateMeta(relPath, filePath, exchanges.length, chunks.length);
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

  async #embedAndStore(chunks, sessionId, isAppend = false) {
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
      chunkIndex: isAppend ? (this.#store.getSessionChunks(sessionId).length + i) : i,
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

    if (isAppend) {
      this.#store.addEntriesToSession(sessionId, entries);
    } else {
      this.#store.addEntries(entries);
    }
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
