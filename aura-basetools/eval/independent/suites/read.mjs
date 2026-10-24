// Read interface: exact slices, search hits, map/digest shape, pagination, changed,
// and structured refusal (not a crash) for non-UTF-8 bytes.

import { inspectBuffer } from '../lib/harness.mjs';

function parseReadText(text) {
  const map = new Map();
  for (const raw of String(text ?? '').split('\n')) {
    const m = /^(\d+): ?([\s\S]*)$/.exec(raw);
    if (!m) continue;
    const content = m[2].replace(/  <h[0-9a-f]+:[\d-]+>$/, '');
    map.set(Number(m[1]), content);
  }
  return map;
}

const TEN = Buffer.from(Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join('\n') + '\n', 'utf8');

export const suite = {
  id: 'read',
  title: '读接口（lines 精确切片 / search / map / digest / changed / offset+limit / 非法 UTF-8）',
  cases: [
    {
      id: 'read/lines-exact-slice',
      purpose: 'lines 3-5 只回这三行，行号与内容都要对；不夹带邻行',
      input: '10 行文件，mode=lines lines=3-5',
      expected: '{3:"line-3",4:"line-4",5:"line-5"}；shown="3-5"',
      async run(t) {
        t.write('f.txt', TEN);
        const r = await t.cliOk(['read', '--file', 'f.txt', '--mode', 'lines', '--lines', '3-5']);
        const map = parseReadText(r.json?.text);
        t.deepEq('exact three lines', { 3: 'line-3', 4: 'line-4', 5: 'line-5' }, Object.fromEntries(map));
        t.eq('shown=3-5', '3-5', r.json?.shown);
        t.eq('totalLines=11 (trailing EOL creates a final empty line)', 11, r.json?.totalLines);
        t.check('handle issued for the requested range', typeof r.json?.handle === 'string' && /:\d+-\d+$/.test(r.json.handle), {
          expected: 'h…:3-5',
          actual: r.json?.handle,
        });
      },
    },
    {
      id: 'read/search-single-hit',
      purpose: 'search 命中唯一 token：次数、行号、文本三者一致',
      input: '10 行文件中第 7 行含 needle，mode=search --search needle',
      expected: 'matches=1；handles[0].line=7；text 含 "7:"',
      async run(t) {
        const lines = Array.from({ length: 10 }, (_, i) => (i === 6 ? 'line-7 needle here' : `line-${i + 1}`));
        t.write('f.txt', Buffer.from(lines.join('\n') + '\n', 'utf8'));
        const r = await t.cliOk(['read', '--file', 'f.txt', '--mode', 'search', '--search', 'needle']);
        t.eq('matches=1', 1, r.json?.matches);
        t.eq('handle line=7', 7, r.json?.handles?.[0]?.line);
        t.check('text shows line 7', /(^|\n)7: /.test(r.json?.text ?? ''), { expected: '7: …', actual: r.json?.text });
      },
    },
    {
      id: 'read/search-zero-hits',
      purpose: 'search 无命中：给结构化 not_found（不伪造 0 命中回执、不崩溃）',
      input: 'mode=search --search absent-token',
      expected: 'exit=2；code=READ_NOT_FOUND；无栈；不返回伪造的 handle',
      async run(t) {
        t.write('f.txt', TEN);
        const r = await t.cli(['read', '--file', 'f.txt', '--mode', 'search', '--search', 'absent-token']);
        t.eq('exit=2', 2, r.code);
        t.eq('code=READ_NOT_FOUND', 'READ_NOT_FOUND', r.json?.code);
        t.check('no node stack frames', !/\n\s+at\s/.test(r.stdout + r.stderr), {
          expected: 'no stack frames',
          actual: (r.stdout + r.stderr).slice(0, 200),
        });
        t.check('no fabricated handles', r.json?.handles == null, { expected: null, actual: r.json?.handles ?? null });
      },
    },
    {
      id: 'read/map-structure',
      purpose: 'map 结构：符号数/种类/行区间来自真实声明',
      input: 'mjs：function alpha (1-3) + const beta (5)；mode=map',
      expected: 'symbols=2；byKind={function:1,variable:1}；totalLines=6',
      async run(t) {
        t.write('f.mjs', Buffer.from('export function alpha() {\n  return 1;\n}\n\nexport const beta = 2;\n', 'utf8'));
        const r = await t.cliOk(['read', '--file', 'f.mjs', '--mode', 'map']);
        t.eq('symbols=2', 2, r.json?.symbols);
        t.deepEq('byKind', { function: 1, variable: 1 }, r.json?.byKind);
        t.eq('totalLines=6', 6, r.json?.totalLines);
        t.check('text lists alpha as function', /function\s+alpha/.test(r.json?.text ?? ''), { expected: 'function alpha', actual: r.json?.text });
        t.check('text lists beta as variable', /variable\s+beta/.test(r.json?.text ?? ''), { expected: 'variable beta', actual: r.json?.text });
      },
    },
    {
      id: 'read/digest-structure',
      purpose: 'digest 结构：exported 清单与签名段存在',
      input: '同一 mjs，mode=digest',
      expected: 'exported 含 "function alpha" 与 "variable beta"；text 含 signatures 段',
      async run(t) {
        t.write('f.mjs', Buffer.from('export function alpha() {\n  return 1;\n}\n\nexport const beta = 2;\n', 'utf8'));
        const r = await t.cliOk(['read', '--file', 'f.mjs', '--mode', 'digest']);
        t.deepEq('exported list', ['function alpha', 'variable beta'], r.json?.exported);
        t.check('signatures section present', /--- signatures ---/.test(r.json?.text ?? ''), {
          expected: '--- signatures ---',
          actual: r.json?.text,
        });
        t.eq('symbols=2', 2, r.json?.symbols);
      },
    },
    {
      id: 'read/offset-limit',
      purpose: 'offset(0-based)+limit 分页与 lines 同形：offset=1 limit=2 ⇒ 第 2-3 行',
      input: '5 行文件，--offset 1 --limit 2',
      expected: 'shown="2-3"；{2:"2",3:"3"}',
      async run(t) {
        t.write('f.txt', Buffer.from('1\n2\n3\n4\n5\n', 'utf8'));
        const r = await t.cliOk(['read', '--file', 'f.txt', '--offset', '1', '--limit', '2']);
        t.eq('shown=2-3', '2-3', r.json?.shown);
        t.deepEq('lines 2 and 3', { 2: '2', 3: '3' }, Object.fromEntries(parseReadText(r.json?.text)));
      },
    },
    {
      id: 'read/mode-plus-offset-refused',
      purpose: '显式 mode 与 offset/limit 同给：按公开承诺被拒（不静默选一个）',
      input: '--mode map --offset 0',
      expected: 'ok=false；有结构化 code',
      async run(t) {
        t.write('f.txt', TEN);
        const r = await t.cli(['read', '--file', 'f.txt', '--mode', 'map', '--offset', '0']);
        t.eq('not JSON failure', false, r.parseFailed);
        t.eq('ok=false', false, r.json?.ok);
        t.check('structured code present', typeof r.json?.code === 'string', { expected: 'code', actual: r.json?.code ?? null });
      },
    },
    {
      id: 'read/changed-since-version',
      purpose: 'changed 模式：用上次读的 version 令牌看差异，内容是新版本',
      input: '读 full 拿 version → 改第 2 行 → changed --since <version>',
      expected: 'mode=changed；text 含 "2: TWO"；version 已变',
      async run(t) {
        t.write('f.txt', Buffer.from('one\ntwo\nthree\n', 'utf8'));
        const first = await t.cliOk(['read', '--file', 'f.txt', '--mode', 'full']);
        await t.cliOk(['edit', '--file', 'f.txt', '--lines', '2', '--replace', 'TWO']);
        const changed = await t.cliOk(['read', '--file', 'f.txt', '--mode', 'changed', '--since', first.json.version]);
        t.eq('mode=changed', 'changed', changed.json?.mode);
        t.check('changed text shows the new line', /(^|\n)2: TWO/.test(changed.json?.text ?? ''), {
          expected: '2: TWO',
          actual: changed.json?.text,
        });
        t.check('version token changed', changed.json?.version !== first.json.version, {
          expected: `!= ${first.json.version}`,
          actual: changed.json?.version,
        });
      },
    },
    {
      id: 'read/invalid-utf8-structured-refusal',
      purpose: '非 UTF-8 字节：结构化拒绝（不崩溃、不吐 Node 栈、不改字节）',
      input: '61 FF FE 62（非法 UTF-8）',
      expected: 'exit=2；code=ERR_ENCODING_INVALID_ENCODED_DATA；无栈；磁盘不变',
      async run(t) {
        const bytes = Buffer.from([0x61, 0xff, 0xfe, 0x62]);
        t.write('bin.txt', bytes);
        const r = await t.cli(['read', '--file', 'bin.txt', '--mode', 'full']);
        t.eq('exit=2', 2, r.code);
        t.eq('stdout is JSON', false, r.parseFailed);
        t.eq('code=ERR_ENCODING_INVALID_ENCODED_DATA', 'ERR_ENCODING_INVALID_ENCODED_DATA', r.json?.code);
        t.check('no node stack frames', !/\n\s+at\s/.test(r.stdout + r.stderr), {
          expected: 'no stack frames',
          actual: (r.stdout + r.stderr).slice(0, 300),
        });
        t.eqBytes('file bytes untouched', bytes, t.read('bin.txt'));
      },
    },
    {
      id: 'read/missing-file-refusal',
      purpose: '读不存在的文件：结构化 FS_NOT_FOUND，不崩溃',
      input: 'nope.txt',
      expected: 'exit=2；code=FS_NOT_FOUND；无栈',
      async run(t) {
        const r = await t.cli(['read', '--file', 'nope.txt', '--mode', 'full']);
        t.eq('exit=2', 2, r.code);
        t.eq('code=FS_NOT_FOUND', 'FS_NOT_FOUND', r.json?.code);
        t.check('no node stack frames', !/\n\s+at\s/.test(r.stdout + r.stderr), { expected: 'no stack frames', actual: (r.stdout + r.stderr).slice(0, 300) });
      },
    },
  ],
};

export { parseReadText, inspectBuffer };
