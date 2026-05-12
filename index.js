/**
 * session-semantic-search/index.js
 *
 * 生命周期管理。
 *
 * 职责：
 * 1. 初始化嵌入器、向量存储和索引器
 * 2. 启动时检测嵌入服务可用性，择机执行全量索引
 * 3. 定时增量扫描新会话
 * 4. 暴露状态查询能力
 */
import path from "node:path";
import { sharedState } from "./lib/shared-state.js";

export default class SessionSemanticSearchPlugin {
  #log = null;
  #bus = null;
  #embedder = null;
  #store = null;
  #indexer = null;
  #config = null;
  #initPromise = null;
  #initDone = false;
  #scanTimer = null;

  async onload() {
    this.#log = this.ctx.log;
    this.#bus = this.ctx.bus;
    this.#config = this.ctx.config;
    this.#log.info("🔍 Session Semantic Search loading...");

    // 初始化核心组件
    const dataDir = this.ctx.dataDir;
    const agentsDir = path.resolve(dataDir, "..", "..", "agents");
    const sessionsDir = path.join(agentsDir, "hanako", "sessions");
    const storePath = path.join(dataDir, "index.json");

    const { Embedder } = await import("./lib/embedder.js");
    const { VectorStore } = await import("./lib/store.js");
    const { SessionIndexer } = await import("./lib/indexer.js");

    const endpoint =
      this.#config?.get?.("embeddingEndpoint") || "http://localhost:11434/api/embed";
    const model = this.#config?.get?.("embeddingModel") || "nomic-embed-text";
    const chunkSize = this.#config?.get?.("chunkSize") || 10;
    const chunkOverlap = this.#config?.get?.("chunkOverlap") || 2;
    const autoIndex = this.#config?.get?.("autoIndex") !== false;
    const indexInterval = (this.#config?.get?.("indexIntervalMinutes") || 30) * 60 * 1000;

    this.#embedder = new Embedder({ endpoint, model, log: this.#log });
    this.#store = new VectorStore(storePath, this.#log);
    await this.#store.load();

    // 将实例写入共享状态，供搜索工具复用
    sharedState.embedder = this.#embedder;
    sharedState.store = this.#store;

    this.#indexer = new SessionIndexer({
      sessionsDir,
      store: this.#store,
      embedder: this.#embedder,
      log: this.#log,
      chunkSize,
      chunkOverlap,
    });

    // 异步初始化：检测嵌入服务 + 首次索引
    this.#initPromise = this.#initialize({ autoIndex });
    this.#initPromise.catch((err) => {
      this.#log.warn(`initialization failed: ${err.message}`);
    });

    // 定时增量扫描
    if (autoIndex && indexInterval > 0) {
      this.#scanTimer = setInterval(() => {
        this.#runIncrementalScan().catch((err) => {
          this.#log.warn(`incremental scan failed: ${err.message}`);
        });
      }, indexInterval);
    }

    // 注册 bus handler：供其他插件或工具触发操作
    this.register(
      this.#bus.handle("session-semantic-search:status", async () => {
        return {
          ready: this.#initDone,
          stats: this.#store.getInfo(),
          embedder: {
            endpoint,
            model,
            online: this.#initDone,
          },
        };
      })
    );

    this.register(
      this.#bus.handle("session-semantic-search:reindex", async () => {
        const result = await this.#indexer.scanAll({ force: true });
        await this.#store.save();
        return result;
      })
    );

    this.register(
      this.#bus.handle("session-semantic-search:index-file", async (payload) => {
        if (!payload?.sessionId) {
          return { error: "sessionId required" };
        }
        return await this.#indexer.indexFile(payload.sessionId);
      })
    );

    this.#log.info("🔍 Session Semantic Search loaded");
  }

  async onunload() {
    this.#log.info("🔍 Session Semantic Search unloading...");

    if (this.#scanTimer) {
      clearInterval(this.#scanTimer);
      this.#scanTimer = null;
    }

    // 清空共享状态
    sharedState.reset();

    // 保存向量索引
    if (this.#store) {
      await this.#store.flush();
    }

    this.#log.info("🔍 Session Semantic Search unloaded");
  }

  /**
   * 异步初始化：检测服务 → 首次全量扫描
   */
  async #initialize({ autoIndex }) {
    const health = await this.#embedder.healthCheck();
    if (!health.ok) {
      this.#log.warn(`embedding service unavailable: ${health.error}`);
      this.#log.warn(`auto-index deferred. Use tool action=reindex when service is ready.`);
      return;
    }

    this.#log.info("embedding service online, checking index state...");

    const stats = this.#store.getStats();

    if (autoIndex && stats.totalChunks === 0) {
      this.#log.info("index empty, starting initial full scan...");
      const result = await this.#indexer.scanAll({ force: false });
      await this.#store.save();
      this.#log.info(
        `initial scan complete: ${result.indexed} sessions indexed, ` +
        `${this.#store.getStats().totalChunks} chunks`
      );
    } else if (autoIndex && stats.totalChunks > 0) {
      this.#log.info(
        `index already has ${stats.totalChunks} chunks from ${stats.totalSessions} sessions, ` +
        `running incremental scan...`
      );
      const result = await this.#indexer.scanIncremental();
      await this.#store.save();
      this.#log.info(`incremental scan complete: ${result.indexed} new`);
    } else {
      this.#log.info(`index has ${stats.totalChunks} chunks, skipping auto-index`);
    }

    this.#initDone = true;
    sharedState.ready = true;
  }

  /**
   * 增量扫描
   */
  async #runIncrementalScan() {
    // 如果初始化还未完成，跳过
    if (!this.#initDone) {
      this.#log.debug("incremental scan skipped: init not done");
      return;
    }

    const health = await this.#embedder.healthCheck();
    if (!health.ok) {
      this.#log.debug("incremental scan skipped: embedder offline");
      return;
    }

    const result = await this.#indexer.scanIncremental();
    if (result.indexed > 0) {
      await this.#store.save();
      this.#log.info(`incremental: ${result.indexed} new sessions indexed`);
    }
  }
}
