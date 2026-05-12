/**
 * lib/shared-state.js
 *
 * 插件内部共享状态。
 *
 * 插件生命周期（index.js）在 onload 时创建 Embedder、VectorStore 和 SessionIndexer
 * 实例，并将它们写入此模块的共享引用。
 * 搜索工具（tools/search.js）读取这些引用，避免每次调用都重新创建实例和加载索引文件。
 *
 * 当插件 onunload 时，共享引用被清空，工具自动降级为独立创建实例。
 */

/** @type {import('./embedder.js').Embedder | null} */
let embedder = null;

/** @type {import('./store.js').VectorStore | null} */
let store = null;

/** @type {import('./indexer.js').SessionIndexer | null} */
let indexer = null;

/** @type {boolean} 插件初始化是否已完成 */
let ready = false;

export const sharedState = {
  get embedder() { return embedder; },
  get store() { return store; },
  get indexer() { return indexer; },
  get ready() { return ready; },

  set embedder(val) { embedder = val; },
  set store(val) { store = val; },
  set indexer(val) { indexer = val; },
  set ready(val) { ready = val; },

  /** 清空所有引用 */
  reset() {
    embedder = null;
    store = null;
    indexer = null;
    ready = false;
  },
};
