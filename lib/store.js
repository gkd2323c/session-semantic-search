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
 *
 * 嵌入向量存储格式：
 * - formatVersion 2：embedding 以 base64 编码的 Float32Array 二进制存储
 *   对外接口始终返回 Float32Array，内部始终为 base64
 * - 旧格式（无 formatVersion / version=1）：embedding 为 number[]，兼容读取
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

    if (storageDirOrFile.endsWith('.json')) {
      this.#filePath = storageDirOrFile;
    } else {
      this.#filePath = path.join(storageDirOrFile, 'index.json');
    }

    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });

    this.#data = {
      formatVersion: 2,
      createdAt: null,
      updatedAt: null,
      entries: [],
    };
    this.#dirty = false;
    this.#createdAt = null;
    this.#updatedAt = null;
  }

  // ── 兼容 API ──────────────────────────────────────────────

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
        this.#data = { formatVersion: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), entries: [] };
        this.#createdAt = this.#data.createdAt;
        this.#updatedAt = this.#data.updatedAt;
      } else {
        this.#log?.warn(`VectorStore: failed to load index, starting fresh: ${err.message}`);
        this.#data = { formatVersion: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), entries: [] };
        this.#createdAt = this.#data.createdAt;
        this.#updatedAt = this.#data.updatedAt;
      }
    }
  }

  async save() {
    if (!this.#dirty) return;
    this.#touchUpdatedAt();
    this.#data.createdAt = this.#createdAt;
    this.#data.updatedAt = this.#updatedAt;
    await fsp.writeFile(this.#filePath, JSON.stringify(this.#data, null, 2), 'utf-8');
    this.#dirty = false;
    this.#log?.debug('VectorStore: saved');
  }

  async flush() {
    if (this.#dirty) await this.save();
  }

  async clear() {
    this.#data.entries = [];
    this.#createdAt = new Date().toISOString();
    this.#updatedAt = this.#createdAt;
    this.#dirty = true;
    this.#log?.info('VectorStore: all data cleared');
  }

  // ── 核心数据操作 ──────────────────────────────────────────

  addEntries(entries) {
    const nextId = this.#data.entries.length > 0
      ? Math.max(...this.#data.entries.map(e => e.id)) + 1
      : 1;

    const newEntries = entries.map((entry, i) => ({
      id: nextId + i,
      sessionId: entry.sessionId,
      chunkIndex: entry.chunkIndex,
      text: entry.text,
      embedding: this.#toStorageFormat(entry.embedding),
      timestamp: entry.timestamp || null,
      metadata: entry.metadata || {},
    }));

    this.#data.entries.push(...newEntries);
    this.#dirty = true;
  }

  addEntriesToSession(sessionId, entries) {
    this.removeSession(sessionId);
    this.addEntries(entries);
  }

  removeSession(sessionId) {
    const before = this.#data.entries.length;
    this.#data.entries = this.#data.entries.filter(e => e.sessionId !== sessionId);
    if (this.#data.entries.length < before) this.#dirty = true;
  }

  // ── 查询方法 ──────────────────────────────────────────────

  getSessionChunks(sessionId) {
    return this.#data.entries
      .filter(e => e.sessionId === sessionId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map(e => this.#decodeEntry(e));
  }

  getAllChunks() {
    return this.#data.entries.map(e => this.#decodeEntry(e));
  }

  getAll() {
    return this.#data.entries.map(e => this.#decodeEntry(e));
  }

  // ── 统计与信息 ────────────────────────────────────────────

  getStats() {
    const entries = this.#data.entries;
    return {
      totalChunks: entries.length,
      totalSessions: new Set(entries.map(e => e.sessionId)).size,
      dimensions: this.#getFirstDimension(),
      avgTextLength: entries.length > 0 ? Math.round(entries.reduce((s, e) => s + (e.text?.length || 0), 0) / entries.length) : 0,
      maxChunkIndex: entries.length > 0 ? Math.max(...entries.map(e => e.chunkIndex)) : 0,
      updatedAt: this.#updatedAt,
    };
  }

  getInfo() {
    const stats = this.getStats();
    return {
      stats,
      dimensions: stats.dimensions,
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
      formatVersion: this.#data.formatVersion || 1,
      storage: 'json',
      filePath: this.#filePath,
    };
  }

  // ── 内部方法 ──────────────────────────────────────────────

  #getFirstDimension() {
    for (const entry of this.#data.entries) {
      if (!entry.embedding) continue;
      if (typeof entry.embedding === 'string') {
        return Math.floor(Buffer.from(entry.embedding, 'base64').length / 4);
      }
      if (Array.isArray(entry.embedding) && entry.embedding.length > 0) {
        return entry.embedding.length;
      }
    }
    return 0;
  }

  /** number[] → base64 字符串 */
  #toStorageFormat(embedding) {
    if (!embedding || !Array.isArray(embedding) || embedding.length === 0) return embedding || null;
    const buf = Buffer.alloc(embedding.length * 4);
    for (let i = 0; i < embedding.length; i++) buf.writeFloatLE(embedding[i], i * 4);
    return buf.toString('base64');
  }

  /** base64 → Float32Array；旧格式 number[] 原样返回 */
  #decodeEmbedding(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      const buf = Buffer.from(value, 'base64');
      const arr = new Float32Array(buf.length / 4);
      for (let i = 0; i < arr.length; i++) arr[i] = buf.readFloatLE(i * 4);
      return arr;
    }
    return value;
  }

  /** 返回 entry 的浅拷贝，embedding 解码为 Float32Array */
  #decodeEntry(entry) {
    if (typeof entry.embedding !== 'string') return entry;
    return { ...entry, embedding: this.#decodeEmbedding(entry.embedding) };
  }

  #touchUpdatedAt() {
    this.#updatedAt = new Date().toISOString();
  }
}
