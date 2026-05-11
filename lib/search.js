/**
 * lib/search.js
 *
 * 语义搜索核心逻辑。
 *
 * 工作流程：
 * 1. 对查询文本做向量化
 * 2. 与存储的所有嵌入向量计算余弦相似度
 * 3. 按相似度排序，返回 Top-N 结果
 * 4. 每个结果附带上下文预览
 */
import { cosineSimilarity } from "./embedder.js";

/**
 * 执行语义搜索
 *
 * @param {object} opts
 * @param {string}   opts.query      - 自然语言查询
 * @param {number[]} opts.queryEmbedding - 预计算好的查询向量（可选，省一次 API 调用）
 * @param {Array}    opts.entries    - 向量存储中的所有条目
 * @param {number}   opts.maxResults - 最大返回数（默认 10）
 * @param {number}   opts.minSimilarity - 最小相似度阈值（默认 0.5）
 * @param {object}   opts.log       - logger
 * @returns {Array<{ id, sessionId, text, score, timestamp, metadata }>}
 */
export function search({ query, queryEmbedding, entries, maxResults = 10, minSimilarity = 0.5, log }) {
  if (!queryEmbedding || queryEmbedding.length === 0) {
    throw new Error("查询向量为空，无法搜索");
  }

  if (!entries || entries.length === 0) {
    return [];
  }

  // 计算每条索引与查询的相似度
  const scored = [];

  for (const entry of entries) {
    if (!entry.embedding || entry.embedding.length === 0) continue;

    try {
      const score = cosineSimilarity(queryEmbedding, entry.embedding);
      scored.push({
        id: entry.id,
        sessionId: entry.sessionId,
        chunkIndex: entry.chunkIndex,
        text: entry.text,
        score,
        timestamp: entry.timestamp,
        metadata: entry.metadata || {},
      });
    } catch (err) {
      log?.warn(`cosine similarity failed for ${entry.id}: ${err.message}`);
    }
  }

  // 按相似度降序排列
  scored.sort((a, b) => b.score - a.score);

  // 过滤低质量结果
  const filtered = scored.filter(r => r.score >= minSimilarity);

  // 截取 Top-N
  const results = filtered.slice(0, maxResults);

  log?.info(
    `search "${query.substring(0, 50)}": ${scored.length} candidates → ` +
    `${filtered.length} ≥ ${minSimilarity} → ${results.length} returned`
  );

  return results;
}

/**
 * 从搜索结果中生成人类可读的报告
 *
 * @param {Array} results - search() 的输出
 * @returns {string} 格式化后的结果文本
 */
export function formatResults(results) {
  if (results.length === 0) {
    return "未找到语义匹配的对话片段。\n\n💡 试试：\n  · 换一种表述重试\n  · 降低 minSimilarity 阈值\n  · 确认对话已索引（执行 reindex）";
  }

  const lines = [];
  lines.push(`🔍 语义搜索命中 ${results.length} 条结果（按相似度降序）\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const scorePct = (r.score * 100).toFixed(1);
    const date = r.timestamp ? r.timestamp.substring(0, 10) : "?";

    // 生成简短的文件名（从 sessionId 中提取日期和 ID 前缀）
    const fileLabel = r.sessionId.replace(/\.jsonl$/, "").substring(0, 40);

    lines.push(`─── [${i + 1}] 匹配度 ${scorePct}% ───────────────────────`);
    lines.push(`📁 ${fileLabel}`);
    lines.push(`📅 ${date}`);

    if (r.metadata.userTopics && r.metadata.userTopics.length > 0) {
      lines.push(`🏷️  ${r.metadata.userTopics.slice(0, 5).join(" · ")}`);
    }

    // 上下文预览：显示对话片段的前几行
    const preview = generatePreview(r.text, 6);
    lines.push(`\n${preview}`);
    lines.push(`\n📎 片段 ${r.chunkIndex + 1}`);
    if (r.metadata.exchangeRange) {
      const [from, to] = r.metadata.exchangeRange;
      lines.push(`💬 第 ${from + 1}-${to + 1} 轮对话`);
    }
    lines.push(""); // 空行分割
  }

  return lines.join("\n");
}

/**
 * 从对话文本中生成预览：
 * 保留前 N 行，如果超出则截断并加提示
 */
function generatePreview(text, maxLines) {
  const lines = text.split("\n").filter(Boolean);
  if (lines.length <= maxLines) {
    return lines.join("\n");
  }
  return lines.slice(0, maxLines).join("\n") + `\n… 还有 ${lines.length - maxLines} 条消息`;
}

/**
 * 生成紧凑的 JSON 格式搜索结果（供程序消费）
 */
export function formatResultsJson(results) {
  return results.map(r => ({
    sessionId: r.sessionId,
    chunkIndex: r.chunkIndex,
    score: Math.round(r.score * 1000) / 1000,
    timestamp: r.timestamp,
    date: r.timestamp ? r.timestamp.substring(0, 10) : "?",
    topics: r.metadata.userTopics || [],
    exchangeRange: r.metadata.exchangeRange || null,
    preview: generatePreview(r.text, 3),
  }));
}
