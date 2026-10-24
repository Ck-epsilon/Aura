// MCP surface: JSON-RPC initialize / tools/list / read / edit / tx lifecycle, the error
// envelope, and byte-level agreement between the MCP and CLI entrypoints.

import { McpClient, hex, replaceLineBuffer } from '../lib/harness.mjs';

const EXPECTED_TOOLS = ['aura_basetools_edit', 'aura_basetools_read', 'aura_basetools_tx', 'aura_basetools_write'];

async function withClient(t, fn) {
  const client = new McpClient({ bin: t.bin, cwd: t.dir, cacheDir: t.cacheDir });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function parseReadText(text) {
  const map = new Map();
  for (const raw of String(text ?? '').split('\n')) {
    const m = /^(\d+): ?([\s\S]*)$/.exec(raw);
    if (!m) continue;
    map.set(Number(m[1]), m[2].replace(/  <h[0-9a-f]+:[\d-]+>$/, ''));
  }
  return map;
}

export const suite = {
  id: 'mcp',
  title: 'MCP 面（initialize / tools/list / read / edit / tx / 错误封装 / 与 CLI 字节一致）',
  cases: [
    {
      id: 'mcp/initialize-and-tools-list',
      purpose: 'initialize 回支持的协议版本与 serverInfo；tools/list 含 read/edit/write/tx；stdout 只有 JSON-RPC 行',
      input: 'initialize(protocolVersion=2025-06-18) + tools/list',
      expected: 'protocolVersion ∈ supported；serverInfo.version=0.19.0；工具列表 = 4 个；无杂行',
      async run(t) {
        t.write('f.txt', Buffer.from('x\n', 'utf8'));
        await withClient(t, async (c) => {
          const init = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eval', version: '1' } });
          const res = init.result ?? {};
          t.eq('protocolVersion echoed as requested', '2025-06-18', res.protocolVersion);
          t.check('protocolVersion is in supported list', Array.isArray(res.supportedProtocolVersions) && res.supportedProtocolVersions.includes(res.protocolVersion), {
            expected: 'supported includes chosen',
            actual: `${res.protocolVersion} in ${JSON.stringify(res.supportedProtocolVersions)}`,
          });
          t.eq('serverInfo.name', 'aura-basetools', res.serverInfo?.name);
          t.eq('serverInfo.version', '0.19.0', res.serverInfo?.version);
          t.check('tools capability declared', Boolean(res.capabilities?.tools), { expected: 'capabilities.tools', actual: JSON.stringify(res.capabilities) });

          const list = await c.rpc('tools/list', {});
          const names = (list.result?.tools ?? []).map((x) => x.name).sort();
          t.deepEq('tools/list = read/edit/write/tx', EXPECTED_TOOLS, names);
          for (const name of EXPECTED_TOOLS) {
            const tool = (list.result?.tools ?? []).find((x) => x.name === name);
            t.check(`${name} has an input schema`, Boolean(tool?.inputSchema || tool?.input_schema), {
              expected: 'inputSchema present',
              actual: Boolean(tool?.inputSchema || tool?.input_schema),
            });
          }
          t.deepEq('no non-JSON-RPC output on stdout', [], c.junk);
          t.eq('stderr quiet', '', c.stderr.trim());
        });
      },
    },
    {
      id: 'mcp/unknown-protocol-not-echoed',
      purpose: '请求一个不存在的协议版本：不回显该版本，而是回自己支持的最高版本（0.11 起承诺）',
      input: 'initialize(protocolVersion="1999-01-01")',
      expected: 'protocolVersion != 1999-01-01 且属于 supportedProtocolVersions',
      async run(t) {
        t.write('f.txt', Buffer.from('x\n', 'utf8'));
        await withClient(t, async (c) => {
          const init = await c.rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'eval', version: '1' } });
          const res = init.result ?? {};
          t.check('does not echo the bogus version', res.protocolVersion !== '1999-01-01', {
            expected: '!= 1999-01-01',
            actual: res.protocolVersion,
          });
          t.check('answers with a supported version', (res.supportedProtocolVersions ?? []).includes(res.protocolVersion), {
            expected: 'supported',
            actual: res.protocolVersion,
          });
        });
      },
    },
    {
      id: 'mcp/read-lines',
      purpose: 'MCP read：与 CLI 同样的行切片语义，isError=false',
      input: '3 行文件，read mode=lines lines=[1,2]',
      expected: '{1:"a",2:"b"}',
      async run(t) {
        t.write('f.txt', Buffer.from('a\nb\nc\n', 'utf8'));
        await withClient(t, async (c) => {
          const r = await c.call('aura_basetools_read', { file_path: t.path('f.txt'), mode: 'lines', lines: [1, 2] });
          t.eq('isError=false', false, r.isError);
          t.eq('ok=true', true, r.json?.ok);
          t.deepEq('lines 1-2', { 1: 'a', 2: 'b' }, Object.fromEntries(parseReadText(r.json?.text)));
        });
      },
    },
    {
      id: 'mcp/edit-bytes',
      purpose: 'MCP edit：磁盘字节与独立 oracle 一致（含 BOM 文件）',
      input: 'BOM + "a\\nb\\n"，hunks=[{lines:[2,2],replace:"B"}]',
      expected: 'BOM + "a\\nB\\n"',
      async run(t) {
        const bom = Buffer.from([0xef, 0xbb, 0xbf]);
        const orig = Buffer.concat([bom, Buffer.from('a\nb\n', 'utf8')]);
        t.write('f.txt', orig);
        const expected = replaceLineBuffer(orig, 2, 'B');
        await withClient(t, async (c) => {
          const r = await c.call('aura_basetools_edit', { file_path: t.path('f.txt'), hunks: [{ lines: [2, 2], replace: 'B' }] });
          t.eq('isError=false', false, r.isError);
          t.eq('ok=true', true, r.json?.ok);
        });
        t.eqBytes('file bytes = oracle', expected, t.read('f.txt'));
      },
    },
    {
      id: 'mcp/tx-begin-edit-commit',
      purpose: 'MCP 事务面：tx begin → edit(transaction) → tx commit，最终字节 = oracle 且状态 committed',
      input: '3 行文件，事务内改行 1 与行 3',
      expected: '磁盘 = "T1x\\nT2\\nT3x\\n"；commit status=committed',
      async run(t) {
        const orig = Buffer.from('T1\nT2\nT3\n', 'utf8');
        t.write('t.txt', orig);
        await withClient(t, async (c) => {
          const b = await c.call('aura_basetools_tx', { action: 'begin' });
          const id = b.json?.transaction?.id;
          t.check('begin returns id', typeof id === 'string' && id.length > 0, { expected: 'id', actual: id });
          const e1 = await c.call('aura_basetools_edit', { file_path: t.path('t.txt'), hunks: [{ lines: [1, 1], replace: 'T1x' }], transaction: id });
          t.eq('tx edit 1 ok', true, e1.json?.ok);
          const e3 = await c.call('aura_basetools_edit', { file_path: t.path('t.txt'), hunks: [{ lines: [3, 3], replace: 'T3x' }], transaction: id });
          t.eq('tx edit 2 ok', true, e3.json?.ok);
          const cm = await c.call('aura_basetools_tx', { action: 'commit', transaction: id });
          t.eq('commit status=committed', 'committed', cm.json?.transaction?.status);
        });
        let expected = replaceLineBuffer(orig, 1, 'T1x');
        expected = replaceLineBuffer(expected, 3, 'T3x');
        t.eqBytes('file bytes = oracle', expected, t.read('t.txt'));
      },
    },
    {
      id: 'mcp/error-envelope',
      purpose: 'MCP 失败封装：isError=true、payload 带结构化 code、磁盘不变、连接不崩',
      input: 'edit lines=99（越界）',
      expected: 'isError=true；code=LOCATOR_OUT_OF_RANGE；磁盘不变；随后仍可正常 read',
      async run(t) {
        const orig = Buffer.from('a\nb\n', 'utf8');
        t.write('f.txt', orig);
        await withClient(t, async (c) => {
          const bad = await c.call('aura_basetools_edit', { file_path: t.path('f.txt'), hunks: [{ lines: [99, 99], replace: 'Z' }] });
          t.eq('isError=true', true, bad.isError);
          t.eq('code=LOCATOR_OUT_OF_RANGE', 'LOCATOR_OUT_OF_RANGE', bad.json?.code);
          const after = await c.call('aura_basetools_read', { file_path: t.path('f.txt'), mode: 'full' });
          t.eq('server still healthy after a failed call', true, after.json?.ok);
        });
        t.eqBytes('disk unchanged', orig, t.read('f.txt'));
      },
    },
    {
      id: 'mcp/cli-mcp-consistency',
      purpose: '同一初始字节、同一处编辑：MCP 与 CLI 落盘结果逐字节一致',
      input: '两份相同文件（BOM + CRLF），分别用 CLI 与 MCP 改第 2 行',
      expected: '两份文件字节完全相同',
      async run(t) {
        const bom = Buffer.from([0xef, 0xbb, 0xbf]);
        const orig = Buffer.concat([bom, Buffer.from('one\r\ntwo\r\nthree\r\n', 'utf8')]);
        t.write('via-cli.txt', orig);
        t.write('via-mcp.txt', orig);
        await t.cliOk(['edit', '--file', 'via-cli.txt', '--lines', '2', '--replace', 'TWO']);
        await withClient(t, async (c) => {
          const r = await c.call('aura_basetools_edit', { file_path: t.path('via-mcp.txt'), hunks: [{ lines: [2, 2], replace: 'TWO' }] });
          t.eq('mcp edit ok', true, r.json?.ok);
        });
        const cliBytes = t.read('via-cli.txt');
        const mcpBytes = t.read('via-mcp.txt');
        t.eqBytes('CLI and MCP produce identical bytes', cliBytes, mcpBytes);
        t.eqBytes('CLI bytes = independent oracle', replaceLineBuffer(orig, 2, 'TWO'), cliBytes);
        t.data = { same: cliBytes.equals(mcpBytes), cliHex: hex(cliBytes), mcpHex: hex(mcpBytes) };
      },
    },
  ],
};
