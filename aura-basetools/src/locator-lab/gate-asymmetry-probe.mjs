#!/usr/bin/env node
/**
 * gate-asymmetry-probe —— 行为级验证："带 expect 的 hunk 不走区域级新鲜度闸门"。
 *
 * 读 write-path.mjs:134-135：
 *   // 带了 `expect` 的 hunk 不走这里：它自己的断言就是闸门（且报错里会贴出原文）。
 *   if (hunk.expect !== undefined && hunk.expect !== null) continue
 * 也就是说：
 *   · 带 expect  ⇒ 只有"机械文本相符"一道门（写者自称知道当刻内容）
 *   · 不带 expect ⇒ 走 staleConflicts，用**会话的读账本**核对区域是否移动/被改
 *
 * 本探针用一个夹具把两种 hunk 放在同一情形下（读 → 行位移 → 再编辑），看各自的结果。
 * 期望（若上述判读成立）：
 *   A 不带 expect、行号已漂移 ⇒ 被拒（judge = 账本）
 *   B 带 expect（内容正确、行号漂移）⇒ 通过（行号是绝对坐标，但闸门不看账本）
 *   C 带 expect（内容正确、行号正确）⇒ 通过
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { contextServices } from './mock-ctx.mjs';

const say = (m) => process.stdout.write(`${m}\n`);
const tmp = path.join(os.tmpdir(), `gate-asym-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });

const writeBytes = (p, t) => {
  const b = Buffer.from(new TextEncoder().encode(t));
  fs.writeFileSync(p, b);
  return b;
};
const readBytes = (p) => fs.readFileSync(p);
const decode = (b) => new TextDecoder('utf-8', { fatal: true }).decode(b);

let version = 1;
const fsService = {
  resolve: async (p) => ({ displayPath: p, targetKey: p }),
  stat: async (t) => (fs.existsSync(t.targetKey) ? { version: `v${version}`, type: 'file', size: fs.statSync(t.targetKey).size } : undefined),
  readText: async (t) => decode(readBytes(t.targetKey)),
  readByteRange: async (t, range) => readBytes(t.targetKey).subarray(range.offset, range.offset + range.length),
  writeText: async (t, content, expected) => {
    const p = t.targetKey;
    const existed = fs.existsSync(p);
    if (expected?.kind === 'replaceIfVersion' && (!existed || `v${version}` !== expected.version)) {
      throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' });
    }
    writeBytes(p, content);
    version += 1;
    return { version: `v${version}`, operation: existed ? 'update' : 'create', after: content };
  },
  editText: async () => {
    throw new Error('editText must not be used by the write path');
  },
};

const readPlugin = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'aura-read', 'index.js')).href);
const editPlugin = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'aura-edit', 'index.js')).href);
let readTool = null;
let editTool = null;
const tools = { register: (t) => (t.name === 'aura_read' ? (readTool = t) : (editTool = t)), get: () => readTool };
const mkCtx = () => ({
  fs: fsService,
  ...contextServices(),
  tools,
  emit: () => {},
  systemPrompt: { section: () => () => {} },
  waterfall: async () => {
    throw Object.assign(new Error('edit requires reading first'), { code: 'FS_NOT_OBSERVED' });
  },
});
readPlugin.apply(mkCtx());
editPlugin.apply(mkCtx());
const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined };
const read = (file, args = {}) => readTool.execute({ file_path: file, ...args }, exec);
const raw = async (args) => {
  try {
    return { ok: true, out: await editTool.execute(args, exec) };
  } catch (error) {
    return { ok: false, code: error.code, message: String(error.message).slice(0, 240) };
  }
};

const SRC = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n') + '\n';

say('夹具：12 行 line1..line12；先读，再在外部插入两行（模拟第三方/别的工具改了文件），然后编辑。');

// ── A：不带 expect，行号按"读到时"的 5..5（插入两行后该处已漂移）
{
  const file = path.join(tmp, 'a_no_expect.md');
  writeBytes(file, SRC);
  version += 1;
  await read(file, { mode: 'full' });
  // 第三方在文件头插入两行
  writeBytes(file, 'INSERTED-A\nINSERTED-B\n' + SRC);
  version += 1;
  const r = await raw({ file_path: file, hunks: [{ start_line: 5, end_line: 5, replace: 'CHANGED-A' }] });
  say(`\nA 不带 expect + 行号已漂移(5)  => ${r.ok ? '通过' : '被拒'}  ${r.ok ? '' : `${r.code}: ${r.message}`}`);
  say(`   落盘检查：${decode(readBytes(file)).includes('CHANGED-A') ? '改了 line5 的位置（现在指向 line3）' : '未改'}`);
}

// ── B：带 expect（内容按"读到时"写 line5，行号 5 —— 已漂移）
{
  const file = path.join(tmp, 'b_with_expect.md');
  writeBytes(file, SRC);
  version += 1;
  await read(file, { mode: 'full' });
  writeBytes(file, 'INSERTED-A\nINSERTED-B\n' + SRC);
  version += 1;
  const r = await raw({ file_path: file, hunks: [{ start_line: 5, end_line: 5, expect: 'line5', replace: 'CHANGED-B' }] });
  say(`\nB 带 expect + 行号已漂移(5)    => ${r.ok ? '通过' : '被拒'}  ${r.ok ? '' : `${r.code}: ${r.message}`}`);
  say(`   落盘检查：${decode(readBytes(file)).includes('CHANGED-B') ? '改掉了（注意改的是谁）' : '未改'}`);
}

// ── C：带 expect，行号也按漂移后的正确位置（7）
{
  const file = path.join(tmp, 'c_ok.md');
  writeBytes(file, SRC);
  version += 1;
  await read(file, { mode: 'full' });
  writeBytes(file, 'INSERTED-A\nINSERTED-B\n' + SRC);
  version += 1;
  const r = await raw({ file_path: file, hunks: [{ start_line: 7, end_line: 7, expect: 'line5', replace: 'CHANGED-C' }] });
  say(`\nC 带 expect + 行号正确(7)      => ${r.ok ? '通过' : '被拒'}  ${r.ok ? '' : `${r.code}: ${r.message}`}`);
}

// ── D：不带 expect、行号正确（7）——控制组
{
  const file = path.join(tmp, 'd_no_expect_ok.md');
  writeBytes(file, SRC);
  version += 1;
  await read(file, { mode: 'full' });
  writeBytes(file, 'INSERTED-A\nINSERTED-B\n' + SRC);
  version += 1;
  const r = await raw({ file_path: file, hunks: [{ start_line: 7, end_line: 7, replace: 'CHANGED-D' }] });
  say(`\nD 不带 expect + 行号正确(7)    => ${r.ok ? '通过' : '被拒'}  ${r.ok ? '' : `${r.code}: ${r.message}`}`);
}

say(`\n夹具目录：${tmp}`);
