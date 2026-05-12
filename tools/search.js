/**
 * tools/search.js
 *
 * 语义搜索工具——Agent 调用入口。
 *
 * 提供能力：
 * - search: 自然语言查询对话历史，返回语义匹配的片段和上下文预览
 * - stats:  查看索引统计
 * - reindex: 手动触发全量重新索引
 * - health: 检查嵌入服务状态
 */

import path from "node:path";
import { Embedder } from "../lib/embedder.js";
import { VectorStore } from "../lib/store.js";
import { SessionIndexer } from "../lib/indexer.js";
import { search, formatResults, formatResultsJson } from "../lib/search.js";
import { sharedState } from "../lib/shared-state.js";

export const name = "search";
export const description = `语义搜索对话历史。使用嵌入模型将查询向量化，与已索引的对话片段做相似度匹配。支持自然语言描述（不需要关键词）。返回带上下文预览的匹配结果。`;
export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["search", "stats", "reindex", "health"],
      description: "操作类型: search=搜索, stats=查看索引统计, reindex=重新索引所有会话, health=检查嵌入服务状态",
    },
    query: {
      type: "string",
      description: "自然语言搜索查询。如 '之前讨论过 MCP 安全相关的内容'、'关于 embedding 模型选择的对话'",
    },
    maxResults: {
      type: "number",
      description: "最大返回结果数（1-30，默认 10）",
      default: 10,
    },
    minSimilarity: {
      type: "number",
      description: "最小相似度阈值 0-1（默认 0.5，越低召回越多）",
      default: 0.5,
    },
    format: {
      type: "string",
      enum: ["json", "text"],
      description: "输出格式: json=结构化数据（默认，AI 解析用）, text=人类可读报告",
      default: "json",
    },
  },
  required: ["action"],
};

export async function execute(input, toolCtx) {
  const { dataDir, config, log } = toolCtx;

  const storePath = path.join(dataDir, "index.json");
  const sessionsDir = path.resolve(dataDir, "..", "..", "agents", "hanako", "sessions");

  const endpoint = config?.get?.("embeddingEndpoint") || "http://localhost:11434/api/embed";
  const model = config?.get?.("embeddingModel") || "qwen3-embedding:0.6b";
  const defaultMaxResults = config?.get?.("maxResults") || 10;
  const defaultMinSimilarity = config?.get?.("minSimilarity") || 0.5;
  const chunkSize = config?.get?.("chunkSize") || 10;
  const chunkOverlap = config?.get?.("chunkOverlap") || 2;

  // 优先复用插件生命周期中的共享实例，避免重复加载 100MB+ 索引文件
  // 降级：插件未就绪时各自创建独立实例
  const embedder = sharedState.ready && sharedState.embedder
    ? sharedState.embedder
    : new Embedder({ endpoint, model, log });

  const store = sharedState.ready && sharedState.store
    ? sharedState.store
    : await (async () => { const s = new VectorStore(storePath, log); await s.load(); return s; })();

  switch (input.action) {
    // ── health: 检查嵌入服务状态 ─────────────────────────────────
    case "health": {
      const health = await embedder.healthCheck();
      const info = store.getInfo();

      const lines = ["🔌 嵌入服务状态\n"];
      if (health.ok) {
        lines.push(`✅ 服务运行中`);
      } else {
        lines.push(`❌ ${health.error}`);
      }
      lines.push(`  端点: ${endpoint}`);
      lines.push(`  模型: ${model}`);
      lines.push(``);
      lines.push(`📊 向量索引概览`);
      lines.push(`  已索引会话: ${info.stats.totalSessions}`);
      lines.push(`  索引片段数: ${info.stats.totalChunks}`);
      if (info.stats.dimensions > 0) {
        lines.push(`  向量维度: ${info.stats.dimensions}`);
      }
      lines.push(`  索引创建: ${info.createdAt ? info.createdAt.substring(0, 19) : "?"}`);
      lines.push(`  最后更新: ${info.updatedAt ? info.updatedAt.substring(0, 19) : "?"}`);

      if (!health.ok) {
        lines.push(``);
        lines.push(`💡 请确保 Ollama 服务正在运行：`);
        lines.push(`  · 启动: ollama serve`);
        lines.push(`  · 拉取模型: ollama pull ${model}`);
        lines.push(`  · 或配置自定义端点（设置 embeddingEndpoint）`);
      }

      return lines.join("\n");
    }

    // ── stats: 索引统计 ──────────────────────────────────────────
    case "stats": {
      const health = await embedder.healthCheck();
      const info = store.getInfo();

      const lines = ["📊 语义搜索引擎 - 索引统计\n"];
      lines.push(`🔌 嵌入服务: ${health.ok ? "✅ 在线" : "❌ 离线"}`);
      lines.push(`  端点: ${endpoint}`);
      lines.push(`  模型: ${model}`);
      lines.push(``);
      lines.push(`📦 向量存储`);
      lines.push(`  索引会话数: ${info.stats.totalSessions}`);
      lines.push(`  索引片段数: ${info.stats.totalChunks}`);
      if (info.stats.dimensions > 0) {
        lines.push(`  向量维度: ${info.stats.dimensions}`);
      }
      lines.push(`  创建时间: ${info.createdAt ? info.createdAt.substring(0, 19) : "?"}`);
      lines.push(`  最后更新: ${info.updatedAt ? info.updatedAt.substring(0, 19) : "?"}`);

      // 读索引元信息
      const indexer = new SessionIndexer({ sessionsDir, store, embedder, log, chunkSize, chunkOverlap });
      const meta = await indexer.getMeta();

      if (meta.lastFullScan) {
        lines.push(``);
        lines.push(`🔄 索引扫描`);
        lines.push(`  全量扫描: ${meta.lastFullScan.substring(0, 19)}`);
        if (meta.lastIncrementalScan) {
          lines.push(`  增量扫描: ${meta.lastIncrementalScan.substring(0, 19)}`);
        }
        const total = Object.keys(meta.indexedFiles).length;
        const withChunks = Object.values(meta.indexedFiles).filter(f => f.chunkCount > 0).length;
        lines.push(`  已跟踪文件: ${total}（其中 ${withChunks} 个有内容）`);
      }

      return lines.join("\n");
    }

    // ── reindex: 全量重新索引 ────────────────────────────────────
    case "reindex": {
      const health = await embedder.healthCheck();
      if (!health.ok) {
        return `❌ 嵌入服务不可用: ${health.error}\n\n请先确保 Ollama 服务正在运行（ollama serve）或配置其他 embedding 端点。`;
      }

      const indexer = new SessionIndexer({ sessionsDir, store, embedder, log, chunkSize, chunkOverlap });

      // 先清空索引
      await store.clear();

      const result = await indexer.scanAll({ force: true });

      return [
        `🔄 全量重新索引完成`,
        `  扫描: ${result.total} 个会话文件`,
        `  新增: ${result.indexed} 个`,
        `  跳过: ${result.skipped} 个（空文件或无内容）`,
        `  当前索引: ${store.getStats().totalChunks} 个片段 / ${store.getStats().totalSessions} 个会话`,
      ].join("\n");
    }

    // ── search: 语义搜索 ──────────────────────────────────────────
    case "search": {
      if (!input.query || input.query.trim().length === 0) {
        return "请提供搜索查询（query 参数）。\n\n示例：\n  query='之前讨论过 MCP 安全相关的内容'\n  query='关于 embedding 模型选择的对话'";
      }

      const health = await embedder.healthCheck();
      if (!health.ok) {
        return `❌ 嵌入服务不可用: ${health.error}\n\n搜索需要嵌入模型来向量化查询。请先确保 Ollama 正在运行或配置自定义 embedding 端点。`;
      }

      const entries = store.getAll();
      if (entries.length === 0) {
        return [
          "📭 索引为空，尚无对话被索引。",
          "",
          "请先执行一次全量索引：",
          "  · 用 search action=reindex 初始化索引",
          "  · 或者等待自动索引在后台完成",
          "",
          "💡 首次索引可能需要几分钟，取决于会话文件数量。",
        ].join("\n");
      }

      // 向量化查询
      const queryEmbedding = await embedder.embed(input.query);

      const maxResults = Math.min(input.maxResults || defaultMaxResults, 30);
      const minSimilarity = input.minSimilarity ?? defaultMinSimilarity;

      const results = search({
        query: input.query,
        queryEmbedding,
        entries,
        maxResults,
        minSimilarity,
        log,
      });

      // 默认输出 JSON（AI 解析用），传递 format=text 获取人类可读报告
      if ((input.format || "json") === "json") {
        return JSON.stringify(formatResultsJson(results), null, 2);
      }

      return formatResults(results);
    }

    default:
      return [
        `未知 action: "${input.action}"`,
        `可用操作: search / stats / reindex / health`,
        ``,
        `示例：`,
        `  search action=health             检查服务状态`,
        `  search action=stats              查看索引统计`,
        `  search action=reindex            全量重新索引`,
        `  search action=search query="xxx" 语义搜索`,
      ].join("\n");
  }
}
