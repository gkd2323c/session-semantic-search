import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export class VectorStore {
  #db;
  #dbPath;

  constructor(storageDir) {
    this.#dbPath = path.join(storageDir, 'vector_store.db');
    this.#db = new Database(this.#dbPath);
    this.#initSchema();
  }

  #initSchema() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        timestamp TEXT,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_session ON chunks(session_id);
    `);
  }

  // 批量添加数据
  addEntries(entries) {
    const insert = this.#db.prepare(`
      INSERT INTO chunks (session_id, chunk_index, text, timestamp, metadata)
      VALUES (@sessionId, @chunkIndex, @text, @timestamp, @metadata)
    `);

    const transaction = this.#db.transaction((entries) => {
      for (const entry of entries) {
        insert.run({
          ...entry,
          metadata: JSON.stringify(entry.metadata)
        });
      }
    });

    transaction(entries);
  }

  // 为特定会话添加数据
  addEntriesToSession(sessionId, entries) {
    this.removeSession(sessionId);
    this.addEntries(entries);
  }

  // 获取会话的所有分片
  getSessionChunks(sessionId) {
    const rows = this.#db.prepare('SELECT * FROM chunks WHERE session_id = ? ORDER BY chunk_index ASC').all(sessionId);
    return rows.map(row => ({
      ...row,
      metadata: JSON.parse(row.metadata)
    }));
  }

  // 获取所有分片（用于搜索）
  getAllChunks() {
    const rows = this.#db.prepare('SELECT * FROM chunks').all();
    return rows.map(row => ({
      ...row,
      metadata: JSON.parse(row.metadata)
    }));
  }

  removeSession(sessionId) {
    this.#db.prepare('DELETE FROM chunks WHERE session_id = ?').run(sessionId);
  }

  // SQLite 本身即时持久化，save() 方法保留兼容接口
  async save() {
    // No-op
  }
}
