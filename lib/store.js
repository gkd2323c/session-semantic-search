/**
 * lib/store.js
 *
 * 向量存储 —— JSON 文件持久化。
 *
 * 存储每个对话片段的文本、嵌入向量和元信息。
 * 提供与旧 SQLite Store 兼容的 API 接口。
 *
 * 使用 JSON 而非 SQLite 的原因：
 * - 消除原生模块（better-sqlite3）的 ABI 兼容依赖
 * - 万级片段量级下 JSON 读写性能完全足够
 * - 避免 native 模块跨 Node.js 版本的编译问题
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class VectorStore {
  #filePath;
  #data;
  #log;
  #createdAt;
  #updatedAt;
  #dirty;

  /**
   * @param {string} storageDirOrFile - 数据目录（或旧风格的 .json 文件路径）
   * @param {object} [log] - logger
   */
  constructor(storageDirOrFile, log) {
    this.#log = log;

    // 兼容旧调用：如果传的是 .json 文件路径，直接使用
    if (storageDirOrFile.endsWith('.json')) {
      this.#filePath = storageDirOrFile;
    } else {
      this.#filePath = path.join(storageDirOrFile, 'index.json');
    }

    // 确保目录存在
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });

    this.#data = {
      version: 1,
      createdAt: null,
      updatedAt: null,
      entries: [],  // { id, sessionId, chunkIndex, text, embedding, timestamp, metadata }
    };
    this.#dirty = false;
    this.#createdAt = null;
    this.#updatedAt = null;
  }

  // ── 兼容 API ──────────────────────────────────────────────

  /**
   * load() - 从 JSON 文件加载数据
   */
  async load() {
    try {
      const raw = await fsp.readFile(this.#filePath, 'utf-8');
      this.#data = JSON.parse(raw);
      this.#createdAt = this.#data.createdAt || new Date().toISOString();
      this.#updatedAt = this.#data.updatedAt || this.#createdAt;
      this.#log?.debug(`VectorStore: loaded ${this.#data.entries.length} entries from ${this.#filePath}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.#log?.debug('VectorStore: no existing index file, starting fresh');
        this.#data = {
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          entries: [],
        };
        this.#createdAt = this.#data.createdAt;
        this.#updatedAt = this.#data.updatedAt;
      } else {
        this.#log?.warn(`VectorStore: failed to load index, starting fresh: ${err.message}`);
        this.#data = {
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          entries: [],
        };
        this.#createdAt = this.#data.createdAt;
        this.#updatedAt = this.#data.updatedAt;
      }
    }
  }

  /**
   * save() - 写入 JSON 文件
   */
  async save() {
    if (!this.#dirty) return;
    this.#touchUpdatedAt();
    this.#data.createdAt = this.#createdAt;
    this.#data.updatedAt = this.#updatedAt;
    await fsp.writeFile(this.#filePath, JSON.stringify(this.#data, null, 2), 'utf-8');
    this.#dirty = false;
    this.#log?.debug('VectorStore: saved');
  }

  /**
   * flush() - 同 save()
   */
  async flush() {
    if (this.#dirty) await this.save();
  }

  /**
   * clear() - 清空所有数据
   */
  async clear() {
    this.#data.entries = [];
    this.#createdAt = new Date().toISOString();
    this.#updatedAt = this.#createdAt;
    this.#dirty = true;
    this.#log?.info('VectorStore: all data cleared');
  }

  // ── 核心数据操作 ──────────────────────────────────────────

  /**
   * 批量添加嵌入条目
   * @param {Array<{sessionId, chunkIndex, text, embedding?, timestamp, metadata?}>} entries
   */
  addEntries(entries) {
    const nextId = this.#data.entries.length > 0
      ? Math.max(...this.#data.entries.map(e => e.id)) + 1
      : 1;

    const newEntries = entries.map((entry, i) => ({
      id: nextId + i,
      sessionId: entry.sessionId,
      chunkIndex: entry.chunkIndex,
      text: entry.text,
      embedding: entry.embedding || null,
      timestamp: entry.timestamp || null,
      metadata: entry.metadata || {},
    }));

    this.#data.entries.push(...newEntries);
    this.#dirty = true;
  }

  /**
   * 为特定会话替换所有条目（先删后插）
   */
  addEntriesToSession(sessionId, entries) {
    this.removeSession(sessionId);
    this.addEntries(entries);
  }

  /**
   * 删除某个会话的所有分片
   */
  removeSession(sessionId) {
    const before = this.#data.entries.length;
    this.#data.entries = this.#data.entries.filter(e => e.sessionId !== sessionId);
    if (this.#data.entries.length < before) {
      this.#dirty = true;
    }
  }

  // ── 查询方法 ──────────────────────────────────────────────

  /**
   * 获取某个会话的所有分片
   */
  getSessionChunks(sessionId) {
    return this.#data.entries
      .filter(e => e.sessionId === sessionId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  /**
   * 获取所有分片（含嵌入向量，用于搜索）
   */
  getAllChunks() {
    return this.#data.entries;
  }

  /**
   * getAll() - 兼容接口，返回所有条目
   */
  getAll() {
    return this.#data.entries;
  }

  // ── 统计与信息 ────────────────────────────────────────────

  /**
   * getStats() - 基础统计
   */
  getStats() {
    const entries = this.#data.entries;
    const totalChunks = entries.length;
    const totalSessions = new Set(entries.map(e => e.sessionId)).size;
    const totalTextLength = entries.reduce((sum, e) => sum + (e.text?.length || 0), 0);
    const avgTextLength = totalChunks > 0 ? Math.round(totalTextLength / totalChunks) : 0;
    const maxChunkIndex = entries.length > 0
      ? Math.max(...entries.map(e => e.chunkIndex))
      : 0;
    const dimensions = this.#getFirstDimension();

    return {
      totalChunks,
      totalSessions,
      dimensions,
      avgTextLength,
      maxChunkIndex,
      updatedAt: this.#updatedAt,
    };
  }

  /**
   * getInfo() - 完整信息（兼容旧接口）
   */
  getInfo() {
    const stats = this.getStats();

    return {
      stats,
      dimensions: stats.dimensions,
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
      storage: 'json',
      filePath: this.#filePath,
    };
  }

  // ── 内部方法 ──────────────────────────────────────────────

  #getFirstDimension() {
    for (const entry of this.#data.entries) {
      if (entry.embedding && Array.isArray(entry.embedding) && entry.embedding.length > 0) {
        return entry.embedding.length;
      }
    }
    return 0;
  }

  #touchUpdatedAt() {
    this.#updatedAt = new Date().toISOString();
  }
}
