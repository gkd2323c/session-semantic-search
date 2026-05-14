/**
 * _test_mirror.mjs
 *
 * Markdown 镜像端到端测试。
 * 1. 创建临时 store + mirror
 * 2. 模拟索引写入几个 chunk
 * 3. 验证 .md 文件生成、内容、目录结构
 * 4. 验证 session 删除后文件同步清理
 * 5. 验证去重（同一内容再次写入不应重复生成文件）
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 测试用 logger ────────────────────────────────────────────

const log = {
  info:  (msg) => console.log(`  ℹ️  ${msg}`),
  debug: (msg) => {}, // 静默 debug
  warn:  (msg) => console.warn(`  ⚠️  ${msg}`),
};

// ── 临时目录 ──────────────────────────────────────────────────

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sss-mirror-test-'));
console.log(`📁 临时工作区: ${tmpDir}`);

// ── 导入被测试模块 ──────────────────────────────────────────────

const { VectorStore } = await import('./lib/store.js');
const { MarkdownMirror } = await import('./lib/markdown-mirror.js');

// ── 模拟数据 ──────────────────────────────────────────────────

const mockEntries = [
  {
    sessionId: 'test-session-001',
    chunkIndex: 0,
    text: '👤 用户: 今天天气怎么样？\n\n🤖 Hanako: 今天天气不错，适合出门散步。',
    contentHash: 'a1b2c3d4e5f6a7b8',
    timestamp: '2026-05-14T10:00:00.000Z',
    metadata: {
      title: '2026-05-14',
      exchangeRange: [0, 1],
      userTopics: ['天气', '散步'],
      chunkSize: 10,
    },
  },
  {
    sessionId: 'test-session-001',
    chunkIndex: 1,
    text: '👤 用户: 明天呢？\n\n🤖 Hanako: 明天预报有雨，不过后天就转晴了。',
    contentHash: 'b2c3d4e5f6a7b8c9',
    timestamp: '2026-05-14T10:01:00.000Z',
    metadata: {
      title: '2026-05-14',
      exchangeRange: [2, 3],
      userTopics: ['天气', '预报'],
      chunkSize: 10,
    },
  },
  {
    sessionId: 'test-session-002',
    chunkIndex: 0,
    text: '👤 用户: 帮我查一下 MCP 协议的文档\n\n🤖 Hanako: MCP 协议的全称是 Model Context Protocol...',
    contentHash: 'c3d4e5f6a7b8c9d0',
    timestamp: '2026-05-13T15:30:00.000Z',
    metadata: {
      title: 'MCP 讨论',
      exchangeRange: [0, 1],
      userTopics: ['MCP', '协议', '文档'],
      chunkSize: 10,
    },
  },
];

// ── 测试辅助 ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

async function assertFileExists(filePath, msg) {
  try {
    await fsp.access(filePath);
    assert(true, msg);
  } catch {
    assert(false, `${msg} (期望存在: ${filePath})`);
  }
}

async function assertFileNotExists(filePath, msg) {
  try {
    await fsp.access(filePath);
    assert(false, `${msg} (期望不存在但文件仍在: ${filePath})`);
  } catch {
    assert(true, msg);
  }
}

// ═══════════════════════════════════════════════════════════════
// 测试 1: MarkdownMirror 直接测试
// ═══════════════════════════════════════════════════════════════

console.log('\n═══ 测试 1: MarkdownMirror 直接写入 ═══\n');

const vaultDir = path.join(tmpDir, 'vault');
const mirror = new MarkdownMirror({ vaultDir, enabled: true, log });

mirror.writeEntries(mockEntries);
await mirror.flush();

// 验证目录结构
const monthDir05 = path.join(vaultDir, 'session-chunks', '2026-05');
const monthDir04 = path.join(vaultDir, 'session-chunks', '2026-04');
await assertFileExists(monthDir05, '2026-05 月份目录已创建');

// 验证文件存在
const files05 = await fsp.readdir(monthDir05);
console.log(`  目录内容: ${files05.join(', ')}`);

assert(files05.length === 3, `生成了 3 个 .md 文件 (实际: ${files05.length})`);

// 验证文件内容
const file001 = files05.find(f => f.startsWith('test-session-001-0-'));
const file002 = files05.find(f => f.startsWith('test-session-002-0-'));
assert(file001, 'session-001 chunk-0 文件存在');
assert(file002, 'session-002 chunk-0 文件存在');

if (file001) {
  const content = await fsp.readFile(path.join(monthDir05, file001), 'utf-8');
  assert(content.startsWith('---\n'), '文件以 YAML frontmatter 开头');
  assert(content.includes('\n---\n'), 'frontmatter 正确闭合');
  assert(content.includes('title:'), 'frontmatter 有 title');
  assert(content.includes('session: "test-session-001"'), 'frontmatter 有 sessionId');
  assert(content.includes('contentHash: "a1b2c3d4'), 'frontmatter 有 contentHash');
  assert(content.includes('天气'), '正文包含对话内容');
  assert(content.includes('散步'), '正文包含话题词');
}

// 验证幂等写入：再次写入相同内容不应新增文件
mirror.writeEntries(mockEntries.slice(0, 1));
await mirror.flush();
const filesAfter = await fsp.readdir(monthDir05);
assert(filesAfter.length === 3, '幂等：重复写入不增加文件');

// ═══════════════════════════════════════════════════════════════
// 测试 2: 通过 store 集成
// ═══════════════════════════════════════════════════════════════

console.log('\n═══ 测试 2: Store + Mirror 集成 ═══\n');

const storePath = path.join(tmpDir, 'store', 'index.json');
const storeVaultDir = path.join(tmpDir, 'store-vault');

const storeMirror = new MarkdownMirror({
  vaultDir: storeVaultDir,
  enabled: true,
  log,
});

const store = new VectorStore(storePath, log);
store.setMirror(storeMirror);
await store.load();

// 写入数据（不带 contentHash，由 store 自动计算）
store.addEntries(mockEntries.map(e => ({
  sessionId: e.sessionId,
  chunkIndex: e.chunkIndex,
  text: e.text,
  timestamp: e.timestamp,
  contentHash: e.contentHash,
  metadata: e.metadata,
})));
await store.save();
await storeMirror.flush();

const storeMonthDir = path.join(storeVaultDir, 'session-chunks', '2026-05');
const storeFiles = await fsp.readdir(storeMonthDir).catch(() => []);
assert(storeFiles.length === 3, '通过 store.addEntries 写入了 3 个 .md 文件');

// 测试：removeSession 同步清理文件
store.removeSession('test-session-001');
await store.save();
await storeMirror.flush();

const storeFilesAfter = await fsp.readdir(storeMonthDir).catch(() => []);
assert(storeFilesAfter.length === 1, 'removeSession 后只剩 session-002 的文件');

const remainingFiles = storeFilesAfter.filter(f => f.startsWith('test-session-001-'));
assert(remainingFiles.length === 0, 'session-001 的文件已全部删除');

// ═══════════════════════════════════════════════════════════════
// 测试 3: 关闭镜像时不应写入
// ═══════════════════════════════════════════════════════════════

console.log('\n═══ 测试 3: 禁用镜像时无文件写入 ═══\n');

storeMirror.setEnabled(false);

// 先清理
for (const file of await fsp.readdir(storeMonthDir).catch(() => [])) {
  await fsp.unlink(path.join(storeMonthDir, file)).catch(() => {});
}

// 再写入
store.addEntries(mockEntries.slice(0, 1));
await store.save();
await storeMirror.flush();

const filesDisabled = await fsp.readdir(storeMonthDir).catch(() => []);
assert(filesDisabled.length === 0, '镜像禁用时无文件写入');

// ═══════════════════════════════════════════════════════════════
// 清理
// ═══════════════════════════════════════════════════════════════

await fsp.rm(tmpDir, { recursive: true, force: true });

// ═══════════════════════════════════════════════════════════════
// 结果汇总
// ═══════════════════════════════════════════════════════════════

console.log(`\n══════════════════════════════════════`);
console.log(`结果: ${passed} ✅  /  ${failed} ❌`);
console.log(`══════════════════════════════════════\n`);

process.exit(failed > 0 ? 1 : 0);
