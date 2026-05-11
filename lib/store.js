/**
 * lib/store.js
 *
 * 向量索引存储层。
 *
 * 使用 JSON 文件持久化向量索引。
 * 每个索引条目包含：
 *   - id:          唯一标识
 *   - sessionId:   所属会话 ID
 *   - chunkIndex:  会话内的片段序号
 *   - text:        对话片段原文
 *   - embedding:   嵌入向量（number[]）
 *   - timestamp:   时间戳
 *   - metadata:    元数据 { title, exchangeRange, userTopics }
 *   - indexedAt:   索引时间
 */
import fsp from "node:fs/promises";
import { existsSync } from "node:fs";

const STORE_VERSION = 1;

export class VectorStore {
  #filePath;
  #log;
  #data;
  #dirty;

  /**
   * @param {string} filePath - 索引文件路径
   * @param {object} log      - logger
   */
  constructor(filePath, log) {
    this.#filePath = filePath;
    this.#log = log;
    this.#data = null;
    this.#dirty = false;
  }

  /** 加载或初始化索引 */
  async load() {
    if (existsSync(this.#filePath)) {
      try {
        const raw = await fsp.readFile(this.#filePath, "utf-8");
        this.#data = JSON.parse(raw);
        if (this.#data.version !== STORE_VERSION) {
          this.#log?.info(`store version mismatch, re-initializing`);
          this.#data = null;
        }
      } catch (err) {
        this.#log?.warn(`failed to load store: ${err.message}, re-initializing`);
        this.#data = null;
      }
    }

    if (!this.#data) {
      this.#data = {
        version: STORE_VERSION,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        entries: [],
        stats: {
          totalSessions: 0,
          totalChunks: 0,
          dimensions: 0,
        },
      };
    }

    return this;
  }

  /** 保存到磁盘（仅 dirty 时写入） */
  async save() {
    if (!this.#dirty) return;
    this.#data.updatedAt = new Date().toISOString();
    this.#data.stats.totalChunks = this.#data.entries.length;
    await fsp.writeFile(this.#filePath, JSON.stringify(this.#data, null, 2), "utf-8");
    this.#dirty = false;
  }

  /** 强制保存 */
  async flush() {
    this.#dirty = true;
    await this.save();
  }

  /** 获取所有条目 */
  getAll() {
    return this.#data.entries;
  }

  /** 获取统计信息 */
  getStats() {
    return { ...this.#data.stats };
  }

  /** 获取已索引的 session ID 集合 */
  getIndexedSessionIds() {
    return new Set(this.#data.entries.map(e => e.sessionId));
  }

  /** 获取指定 session 的所有片段 */
  getSessionChunks(sessionId) {
    return this.#data.entries.filter(e => e.sessionId === sessionId);
  }

  /** 添加一条索引条目 */
  addEntry({ sessionId, chunkIndex, text, embedding, timestamp, metadata }) {
    const entry = {
      id: `${sessionId}_chunk_${chunkIndex}`,
      sessionId,
      chunkIndex,
      text,
      embedding,
      timestamp: timestamp || new Date().toISOString(),
      metadata: metadata || {},
      indexedAt: new Date().toISOString(),
    };

    this.#data.entries.push(entry);
    this.#dirty = true;

    // 更新统计
    const uniqueSessions = new Set(this.#data.entries.map(e => e.sessionId));
    this.#data.stats.totalSessions = uniqueSessions.size;
    this.#data.stats.totalChunks = this.#data.entries.length;
    this.#data.stats.dimensions = embedding.length;

    return entry;
  }

  /** 批量追加条目到指定 session（高效，无需移除旧条目） */
  addEntriesToSession(sessionId, entries) {
    for (const e of entries) {
      this.#data.entries.push({
        id: `${e.sessionId}_chunk_${e.chunkIndex}`,
        sessionId: e.sessionId,
        chunkIndex: e.chunkIndex,
        text: e.text,
        embedding: e.embedding,
        timestamp: e.timestamp || new Date().toISOString(),
        metadata: e.metadata || {},
        indexedAt: new Date().toISOString(),
      });
    }
    this.#dirty = true;

    const uniqueSessions = new Set(this.#data.entries.map(e => e.sessionId));
    this.#data.stats.totalSessions = uniqueSessions.size;
    this.#data.stats.totalChunks = this.#data.entries.length;
    if (entries.length > 0 && entries[0].embedding) {
      this.#data.stats.dimensions = entries[0].embedding.length;
    }
  }

  /** 删除指定 session 的所有索引条目 */
  removeSession(sessionId) {
    const before = this.#data.entries.length;
    this.#data.entries = this.#data.entries.filter(e => e.sessionId !== sessionId);
    if (this.#data.entries.length !== before) {
      this.#dirty = true;
      const uniqueSessions = new Set(this.#data.entries.map(e => e.sessionId));
      this.#data.stats.totalSessions = uniqueSessions.size;
      this.#data.stats.totalChunks = this.#data.entries.length;
    }
  }

  /** 清空整个索引 */
  async clear() {
    this.#data = {
      version: STORE_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: [],
      stats: { totalSessions: 0, totalChunks: 0, dimensions: 0 },
    };
    this.#dirty = true;
    await this.save();
  }

  /** 获取索引元信息 */
  getInfo() {
    return {
      version: this.#data.version,
      createdAt: this.#data.createdAt,
      updatedAt: this.#data.updatedAt,
      stats: this.#data.stats,
    };
  }
}
