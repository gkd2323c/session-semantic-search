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
 *
 * 内容寻址去重（v2.1）：
 * - 每条条目有一个 contentHash（sha256 取文本前 16 字符），在 addEntries 时自动去重
 * - 加载时建立 #contentIndex 索引，O(1) 查重
 * - 旧条目首次加载时自动计算 contentHash
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeNorm } from './embedder.js';

export class VectorStore {
  #filePath;
  #data;
  #log;
  #createdAt;
  #updatedAt;
  #dirty;
  #contentIndex;
  #mirror;

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
    this.#contentIndex = new Set();
  }

  // ── 兼容 API ──────────────────────────────────────────────

  async load() {
    try {
      const raw = await fsp.readFile(this.#filePath, 'utf-8');
      this.#data = JSON.parse(raw);
      this.#createdAt = this.#data.createdAt || new Date().toISOString();
      this.#updatedAt = this.#data.updatedAt || this.#createdAt;
      this.#rebuildContentIndex();
      this.#log?.debug(`VectorStore: loaded ${this.#data.entries.length} entries from ${this.#filePath}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.#log?.debug('VectorStore: no existing index file, starting fresh');
        this.#data = { formatVersion: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), entries: [] };
        this.#createdAt = this.#data.createdAt;
        this.#updatedAt = this.#data.updatedAt;
        this.#contentIndex = new Set();
      } else {
        this.#log?.warn(`VectorStore: failed to load index, starting fresh: ${err.message}`);
        this.#data = { formatVersion: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), entries: [] };
        this.#createdAt = this.#data.createdAt;
        this.#updatedAt = this.#data.updatedAt;
        this.#contentIndex = new Set();
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
    this.#contentIndex = new Set();
    this.#dirty = true;
    this.#log?.info('VectorStore: all data cleared');
  }

  /**
   * 绑定 Markdown 镜像输出端
   * @param {import('./markdown-mirror.js').MarkdownMirror} mirror
   */
  setMirror(mirror) {
    this.#mirror = mirror;
  }

  // ── 核心数据操作 ──────────────────────────────────────────

  /**
   * 对文本生成内容寻址 hash（sha256 前缀，16 字符 hex 够防碰撞）
   * @param {string} text
   * @returns {string}
   */
  static contentHash(text) {
    return crypto.createHash('sha256').update(text, 'utf-8').digest('hex').substring(0, 16);
  }

  /**
   * 判断给定 hash 是否已存在
   * @param {string} hash
   * @returns {boolean}
   */
  hasContentHash(hash) {
    return this.#contentIndex.has(hash);
  }

  /**
   * 从 entries 数组中过滤出尚未索引的新 chunk（通过 contentHash 判断）
   * 这样调用方可以避免对重复内容做昂贵的嵌入调用
   * @param {Array<{text:string}>} entries
   * @returns {Array} 只包含新条目的子集
   */
  filterNew(entries) {
    return entries.filter(e => {
      const hash = VectorStore.contentHash(e.text);
      return !this.#contentIndex.has(hash);
    });
  }

  addEntries(entries) {
    if (entries.length === 0) return;

    const nextId = this.#data.entries.length > 0
      ? Math.max(...this.#data.entries.map(e => e.id)) + 1
      : 1;

    let added = 0;
    const newEntries = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const hash = entry.contentHash || VectorStore.contentHash(entry.text);

      // 内容寻址去重
      if (this.#contentIndex.has(hash)) {
        this.#log?.debug(`dedup: skipping duplicate contentHash=${hash}`);
        continue;
      }

      const embedding = this.#toStorageFormat(entry.embedding);

      const norm = entry.embedding && Array.isArray(entry.embedding)
        ? computeNorm(entry.embedding)
        : (entry.norm || 0);

      const newEntry = {
        id: nextId + added,
        contentHash: hash,
        sessionId: entry.sessionId,
        chunkIndex: entry.chunkIndex,
        text: entry.text,
        embedding,
        norm,
        timestamp: entry.timestamp || null,
        metadata: entry.metadata || {},
      };

      newEntries.push(newEntry);
      this.#contentIndex.add(hash);
      added++;
    }

    this.#data.entries.push(...newEntries);
    this.#dirty = true;

    // Markdown 镜像：fire-and-forget 写文件
    if (this.#mirror && newEntries.length > 0) {
      this.#mirror.writeEntries(newEntries);
    }

    if (added < entries.length) {
      this.#log?.info(`addEntries: ${added}/${entries.length} added (${entries.length - added} deduped)`);
    }
  }

  addEntriesToSession(sessionId, entries) {
    this.removeSession(sessionId);
    this.addEntries(entries);
  }

  removeSession(sessionId) {
    const before = this.#data.entries.length;
    this.#data.entries = this.#data.entries.filter(e => e.sessionId !== sessionId);
    if (this.#data.entries.length < before) {
      this.#dirty = true;
      this.#rebuildContentIndex();
      // Markdown 镜像：同步删除对应文件
      this.#mirror?.removeSession(sessionId);
    }
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
      uniqueChunks: this.#contentIndex.size,
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

  // ── 格式迁移 ──────────────────────────────────────────────

  /**
   * 将存储中所有旧格式（number[]）的嵌入向量迁移为 base64 格式。
   * 已经足 base64 格式的条目不受影响。
   * @returns {{ migrated: number, total: number, sizeBefore: string, sizeAfter: string }}
   */
  async migrate() {
    let migrated = 0;
    const entries = this.#data.entries;

    for (const entry of entries) {
      if (entry.embedding && Array.isArray(entry.embedding)) {
        entry.embedding = this.#toStorageFormat(entry.embedding);
        migrated++;
      }
    }

    if (migrated > 0) {
      this.#dirty = true;
      this.#data.formatVersion = 2;
      await this.save();

      // 重新读取以确认大小
      const raw = await fsp.readFile(this.#filePath, 'utf-8');
      const beforeBytes = Buffer.byteLength(raw, 'utf-8');
      const afterBytes = Buffer.byteLength(JSON.stringify(this.#data), 'utf-8');
      return {
        migrated,
        total: entries.length,
        sizeBefore: this.#formatBytes(beforeBytes),
        sizeAfter: this.#formatBytes(afterBytes),
      };
    }

    return { migrated: 0, total: entries.length, sizeBefore: '-', sizeAfter: '-' };
  }

  // ── 内部方法 ──────────────────────────────────────────────

  /** 从当前 entries 重建内容索引 */
  #rebuildContentIndex() {
    this.#contentIndex = new Set();
    for (const entry of this.#data.entries) {
      const hash = entry.contentHash || VectorStore.contentHash(entry.text);
      // 旧条目没有 contentHash，回填
      if (!entry.contentHash) {
        entry.contentHash = hash;
        this.#dirty = true;
      }
      this.#contentIndex.add(hash);
    }
    this.#log?.debug(`VectorStore: rebuilt content index with ${this.#contentIndex.size} unique hashes`);
  }

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

  /** 返回 entry 的浅拷贝，embedding 解码为 Float32Array，norm 保留 */
  #decodeEntry(entry) {
    if (typeof entry.embedding !== 'string') return entry;
    const decoded = this.#decodeEmbedding(entry.embedding);
    // norm 可能为 undefined（旧格式未计算），让余弦相似度函数自动降级
    return { ...entry, embedding: decoded, norm: entry.norm };
  }

  #touchUpdatedAt() {
    this.#updatedAt = new Date().toISOString();
  }

  #formatBytes(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  }
}
