/**
 * lib/markdown-mirror.js
 *
 * Markdown 双写镜像。
 *
 * 当索引器向向量存储写入新 chunk 时，同步将 chunk 渲染成人类可读的
 * Markdown 文件写入 vault 目录。这样你可以在任何编辑器中翻阅、修正
 * 记忆内容，离开时也能带走一份完整的知识库。
 *
 * 设计原则：
 * - Fire-and-forget：主流程不 await 写入，通过队列串行化防止并发冲突
 * - 无外部依赖：只使用 Node.js 原生 fs/path
 * - 可独立开关：通过 enabled 配置完全禁用
 * - 幂等写入：contentHash 作文件名一部分，重复调用不会产生重复文件
 *
 * 目录结构：
 *   vault/
 *   └── session-chunks/
 *       ├── 2026-05/
 *       │   ├── <sessionId>-<chunkIndex>-<hashPrefix>.md
 *       │   └── ...
 *       └── 2026-06/
 *           └── ...
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_VAULT_DIR = 'vault';
const CHUNKS_DIR = 'session-chunks';

export class MarkdownMirror {
  #vaultDir;
  #chunksDir;
  #enabled;
  #log;
  #queue;   // 串行化写入队列，避免并发冲突
  #flushTimer;

  /**
   * @param {object} opts
   * @param {string}  opts.vaultDir  - vault 根目录（绝对路径）
   * @param {boolean} [opts.enabled] - 是否启用，默认 true
   * @param {object}  [opts.log]     - logger
   */
  constructor({ vaultDir, enabled = true, log }) {
    this.#vaultDir = vaultDir;
    this.#chunksDir = path.join(vaultDir, CHUNKS_DIR);
    this.#enabled = enabled;
    this.#log = log;
    this.#queue = Promise.resolve();
    this.#flushTimer = null;
  }

  get enabled() { return this.#enabled; }
  get vaultDir() { return this.#vaultDir; }

  /** 动态开关 */
  setEnabled(v) { this.#enabled = v; }

  /**
   * 写入一组 chunk 对应的 Markdown 文件
   * 每个 chunk 写一个文件，按月份分目录
   *
   * @param {Array<{sessionId, chunkIndex, text, contentHash, timestamp, metadata}>} entries
   */
  writeEntries(entries) {
    if (!this.#enabled || !entries || entries.length === 0) return;
    // 入队串行化，不阻塞主流程
    this.#queue = this.#queue.then(() => this.#doWriteEntries(entries)).catch(err => {
      this.#log?.warn(`[mirror] write batch failed: ${err.message}`);
    });
  }

  /**
   * 移除某个 session 对应的所有 Markdown 文件
   * @param {string} sessionId
   */
  removeSession(sessionId) {
    if (!this.#enabled) return;
    this.#queue = this.#queue.then(() => this.#doRemoveSession(sessionId)).catch(err => {
      this.#log?.warn(`[mirror] remove session failed: ${err.message}`);
    });
  }

  /**
   * 刷新待处理的写入
   */
  async flush() {
    await this.#queue;
  }

  // ── 内部：串行写入 ──────────────────────────────────────────

  async #doWriteEntries(entries) {
    // 按月分组，批量创建目录
    const byMonth = new Map();
    for (const entry of entries) {
      const monthDir = this.#monthDir(entry.timestamp);
      if (!byMonth.has(monthDir)) byMonth.set(monthDir, []);
      byMonth.get(monthDir).push(entry);
    }

    for (const [monthDir, batch] of byMonth) {
      await fsp.mkdir(monthDir, { recursive: true });

      for (const entry of batch) {
        const filePath = this.#entryPath(entry);
        const content = this.#render(entry);

        try {
          await fsp.writeFile(filePath, content, 'utf-8');
        } catch (err) {
          this.#log?.warn(`[mirror] write failed: ${filePath} — ${err.message}`);
        }
      }
    }

    this.#log?.debug(`[mirror] wrote ${entries.length} files to ${this.#chunksDir}`);
  }

  async #doRemoveSession(sessionId) {
    // 搜索所有月份目录下匹配该 sessionId 的文件并删除
    // 这是一种简单但可靠的做法：文件数量不会庞大到性能不可接受
    try {
      const months = await fsp.readdir(this.#chunksDir).catch(() => []);
      let removed = 0;

      for (const month of months) {
        const monthDir = path.join(this.#chunksDir, month);
        const stat = await fsp.stat(monthDir).catch(() => null);
        if (!stat || !stat.isDirectory()) continue;

        const files = await fsp.readdir(monthDir);
        for (const file of files) {
          if (file.startsWith(sessionId)) {
            await fsp.unlink(path.join(monthDir, file)).catch(() => {});
            removed++;
          }
        }
      }

      if (removed > 0) {
        this.#log?.debug(`[mirror] removed ${removed} files for session ${sessionId}`);
      }
    } catch (err) {
      this.#log?.warn(`[mirror] remove session ${sessionId} failed: ${err.message}`);
    }
  }

  // ── 路径和渲染 ──────────────────────────────────────────────

  /** 按月份分目录：vault/session-chunks/YYYY-MM/ */
  #monthDir(timestamp) {
    const d = timestamp ? new Date(timestamp) : new Date();
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return path.join(this.#chunksDir, month);
  }

  /** 文件路径：<monthDir>/<sessionId>-<chunkIndex>-<hashPrefix>.md */
  #entryPath(entry) {
    const safeSession = entry.sessionId.replace(/[<>:"/\\|?*]/g, '_');
    const hashPrefix = (entry.contentHash || '').substring(0, 8);
    const monthDir = this.#monthDir(entry.timestamp);
    const fileName = `${safeSession}-${entry.chunkIndex}-${hashPrefix}.md`;
    return path.join(monthDir, fileName);
  }

  /**
   * 渲染完整 Markdown 内容
   * 包含 frontmatter + 正文
   */
  #render(entry) {
    const frontmatter = this.#renderFrontmatter(entry);
    const body = this.#renderBody(entry);
    return `${frontmatter}\n${body}\n`;
  }

  #renderFrontmatter(entry) {
    const meta = entry.metadata || {};
    const title = meta.title || entry.timestamp?.substring(0, 10) || 'unknown';
    const topics = (meta.userTopics || []).join(', ');
    const exchangeRange = meta.exchangeRange
      ? `${meta.exchangeRange[0]}-${meta.exchangeRange[1]}`
      : '';

    const lines = [
      '---',
      `title: "${title}"`,
      `session: "${entry.sessionId}"`,
      `chunkIndex: ${entry.chunkIndex}`,
      `contentHash: "${entry.contentHash || ''}"`,
      `timestamp: "${entry.timestamp || ''}"`,
      exchangeRange ? `exchangeRange: "${exchangeRange}"` : '',
      topics ? `topics: "${topics}"` : '',
      `source: "session-semantic-search"`,
      '---',
    ];

    return lines.filter(Boolean).join('\n');
  }

  #renderBody(entry) {
    const meta = entry.metadata || {};

    let header = `# ${meta.title || '对话片段'}\n\n`;

    if (meta.exchangeRange) {
      header += `> 对话轮次 ${meta.exchangeRange[0] + 1}–${meta.exchangeRange[1] + 1}  ·  `;
    }
    if (entry.timestamp) {
      header += `📅 ${entry.timestamp.substring(0, 10)}\n\n`;
    } else {
      header += '\n';
    }

    if (meta.userTopics && meta.userTopics.length > 0) {
      header += `🏷️  ${meta.userTopics.slice(0, 8).join(' · ')}\n\n`;
    }

    return header + entry.text;
  }
}
