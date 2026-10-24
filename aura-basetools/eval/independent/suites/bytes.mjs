// Byte fidelity: every case compares the exact bytes on disk against an expectation
// built here from Buffers (never from the tool's own receipt).

import { BOM_BYTES, adaptEol, inspectBuffer, replaceLineBuffer } from '../lib/harness.mjs';

const bom = (s) => Buffer.concat([BOM_BYTES, Buffer.from(s, 'utf8')]);

export const suite = {
  id: 'bytes',
  title: '字节保真（BOM / CRLF / 混合行尾 / 无尾换行 / Unicode / 空文件 / BOM-only）',
  cases: [
    {
      id: 'bytes/bom-crlf-cjk',
      purpose: '带 BOM + CRLF + CJK 的文件，改第 2 行：BOM 与所有 CRLF 必须原样保留，只有该行内容变',
      input: 'BOM + "第一行\\r\\n第二行\\r\\n第三行\\r\\n"',
      expected: 'BOM 保留；三处 CRLF 不变；仅第 2 行内容替换',
      async run(t) {
        const orig = bom('第一行\r\n第二行\r\n第三行\r\n');
        t.write('f.txt', orig);
        const expected = replaceLineBuffer(orig, 2, 'SECOND 行');
        const r = await t.cliOk(['edit', '--file', 'f.txt', '--lines', '2', '--replace', 'SECOND 行']);
        t.eqBytes('file bytes match independent oracle', expected, t.read('f.txt'));
        t.eq('BOM still present', true, inspectBuffer(t.read('f.txt')).hasBom);
        t.eq('eol style still CRLF', 'crlf', eolStyleOf(t.read('f.txt')));
        t.check('receipt reports byte-level verification', r.json?.result?.write_verify?.level === 'bytes', {
          expected: 'bytes',
          actual: r.json?.result?.write_verify?.level,
        });
      },
    },
    {
      id: 'bytes/crlf-only',
      purpose: '纯 CRLF 文件改第 1 行：不得引入裸 LF（混合行尾是常见破坏）',
      input: '"p1\\r\\np2\\r\\np3\\r\\n"',
      expected: '全部行尾仍为 CRLF；第 1 行内容替换',
      async run(t) {
        const orig = Buffer.from('p1\r\np2\r\np3\r\n', 'utf8');
        t.write('f.txt', orig);
        const expected = replaceLineBuffer(orig, 1, 'P1');
        await t.cliOk(['edit', '--file', 'f.txt', '--lines', '1', '--replace', 'P1']);
        t.eqBytes('file bytes match independent oracle', expected, t.read('f.txt'));
        t.eq('no bare LF introduced', 0, countBareLf(t.read('f.txt')));
      },
    },
    {
      id: 'bytes/mixed-eol',
      purpose: '混合行尾（LF/CRLF/LF）改中间 CRLF 行：其它行的行尾一个字节都不能动',
      input: '"a\\nb\\r\\nc\\nd\\n"',
      expected: '行尾序列保持 [LF, CRLF, LF, LF]；仅第 2 行内容替换',
      async run(t) {
        const orig = Buffer.from('a\nb\r\nc\nd\n', 'utf8');
        t.write('f.txt', orig);
        const expected = replaceLineBuffer(orig, 2, 'B');
        await t.cliOk(['edit', '--file', 'f.txt', '--lines', '2', '--replace', 'B']);
        t.eqBytes('file bytes match independent oracle', expected, t.read('f.txt'));
        t.deepEq('per-line eol unchanged', ['lf', 'crlf', 'lf', 'lf', 'none'], inspectBuffer(t.read('f.txt')).lines.map((l) => eolOf(l.eol)));
      },
    },
    {
      id: 'bytes/no-trailing-newline',
      purpose: '无尾换行文件改最后一行：不得补尾换行',
      input: '"x\\ny"（无尾换行）',
      expected: '"x\\nY"（仍无尾换行）',
      async run(t) {
        const orig = Buffer.from('x\ny', 'utf8');
        t.write('f.txt', orig);
        const expected = replaceLineBuffer(orig, 2, 'Y');
        await t.cliOk(['edit', '--file', 'f.txt', '--lines', '2', '--replace', 'Y']);
        t.eqBytes('file bytes match independent oracle', expected, t.read('f.txt'));
        t.eq('file still ends without newline', false, t.read('f.txt').toString('utf8').endsWith('\n'));
      },
    },
    {
      id: 'bytes/all-features',
      purpose: 'BOM + CRLF + 无尾换行 + CJK/emoji 同时存在，改最后一行',
      input: 'BOM + "甲\\r\\n乙🚀\\r\\n丙"（无尾换行）',
      expected: 'BOM 保留、CRLF 保留、仍无尾换行、emoji 字节不变',
      async run(t) {
        const orig = bom('甲\r\n乙🚀\r\n丙');
        t.write('f.txt', orig);
        const expected = replaceLineBuffer(orig, 3, '丙✅ done');
        await t.cliOk(['edit', '--file', 'f.txt', '--lines', '3', '--replace', '丙✅ done']);
        t.eqBytes('file bytes match independent oracle', expected, t.read('f.txt'));
        t.eq('BOM preserved', true, inspectBuffer(t.read('f.txt')).hasBom);
        t.eq('emoji line untouched', '乙🚀', inspectBuffer(t.read('f.txt')).lines[1].content.toString('utf8'));
      },
    },
    {
      id: 'bytes/unicode-emoji',
      purpose: 'Unicode/CJK/emoji/组合字符改一行：UTF-8 字节必须逐字节正确（不分解、不替换）',
      input: '"café\\n漢字テスト\\n👨‍👩‍👧‍👦 family\\nline4\\n"',
      expected: '仅第 3 行替换；其余 UTF-8 字节完全一致',
      async run(t) {
        const orig = Buffer.from('café\n漢字テスト\n👨‍👩‍👧‍👦 family\nline4\n', 'utf8');
        t.write('f.txt', orig);
        const expected = replaceLineBuffer(orig, 3, '🙂 rocket 🚀');
        await t.cliOk(['edit', '--file', 'f.txt', '--lines', '3', '--replace', '🙂 rocket 🚀']);
        t.eqBytes('file bytes match independent oracle', expected, t.read('f.txt'));
        const after = inspectBuffer(t.read('f.txt'));
        t.eq('line 1 akzent intact', 'café', after.lines[0].content.toString('utf8'));
        t.eq('line 2 kana intact', '漢字テスト', after.lines[1].content.toString('utf8'));
        t.eq('line 4 untouched', 'line4', after.lines[3].content.toString('utf8'));
      },
    },
    {
      id: 'bytes/empty-file-write',
      purpose: '0 字节文件先读后整份写：写入内容必须逐字节等于 content，不额外加 BOM/换行',
      input: '0 字节文件；content = "abc\\n"',
      expected: '61 62 63 0a',
      async run(t) {
        t.write('empty.txt', Buffer.alloc(0));
        const read = await t.cliOk(['read', '--file', 'empty.txt', '--mode', 'full']);
        t.check('read of empty file is structured (totalLines>=1)', read.json?.ok === true && read.json.totalLines >= 1, {
          expected: 'ok with totalLines>=1',
          actual: read.json ? `ok=${read.json.ok} totalLines=${read.json.totalLines}` : '<no json>',
        });
        await t.cliOk(['write', '--file', 'empty.txt', '--content', 'abc\n']);
        t.eqBytes('written bytes exactly equal content', Buffer.from('abc\n', 'utf8'), t.read('empty.txt'));
      },
    },
    {
      id: 'bytes/bom-only',
      purpose: '只有 3 字节 BOM 的文件改第 1 行（内容为空行）：BOM 必须保留，且不产生多余换行',
      input: 'EF BB BF（无正文）',
      expected: 'EF BB BF + "hi"',
      async run(t) {
        t.write('f.txt', BOM_BYTES);
        await t.cliOk(['edit', '--file', 'f.txt', '--lines', '1', '--replace', 'hi']);
        t.eqBytes('bytes = BOM + hi', Buffer.concat([BOM_BYTES, Buffer.from('hi', 'utf8')]), t.read('f.txt'));
      },
    },
    {
      id: 'bytes/crlf-eol-auto-multiline',
      purpose: 'CRLF 文件里用含 \\n 的多行 replace：eol=auto 应把新行写成 CRLF（不制造混合行尾）',
      input: 'CRLF 文件，第 2 行替换为 "P2a\\nP2b"',
      expected: '替换文本的 \\n 适配成 CRLF；回执 eolAdapted=true',
      async run(t) {
        const orig = Buffer.from('p1\r\np2\r\np3\r\n', 'utf8');
        t.write('f.txt', orig);
        const expected = replaceLineBuffer(orig, 2, adaptEol('P2a\nP2b', 'crlf'));
        const r = await t.cliOk(['edit', '--file', 'f.txt', '--lines', '2', '--replace', 'P2a\nP2b']);
        t.eqBytes('file bytes match independent oracle', expected, t.read('f.txt'));
        t.eq('no bare LF introduced', 0, countBareLf(t.read('f.txt')));
        t.eq('receipt eolAdapted=true', true, r.json?.result?.applied?.[0]?.eolAdapted ?? false);
      },
    },
    {
      id: 'bytes/eol-preserve',
      purpose: 'eol=preserve：替换文本按输入原样写出（CRLF 文件里允许出现 LF，这是显式选择）',
      input: 'CRLF 文件，第 2 行替换为 "P2a\\nP2b"，--eol preserve',
      expected: '文件 = p1\\r\\n + "P2a\\nP2b" + \\r\\n + p3\\r\\n（按 content 原样）',
      async run(t) {
        const orig = Buffer.from('p1\r\np2\r\np3\r\n', 'utf8');
        t.write('f.txt', orig);
        const expected = replaceLineBuffer(orig, 2, 'P2a\nP2b'); // raw, no adaptation
        const r = await t.cliOk(['edit', '--file', 'f.txt', '--lines', '2', '--replace', 'P2a\nP2b', '--eol', 'preserve']);
        t.eqBytes('file bytes match independent oracle', expected, t.read('f.txt'));
        t.eq('only the preserved LF appears (1 bare LF)', 1, countBareLf(t.read('f.txt')));
        t.check('receipt does not claim eol adaptation', r.json?.result?.applied?.[0]?.eolAdapted !== true, {
          expected: 'no eolAdapted',
          actual: r.json?.result?.applied?.[0]?.eolAdapted,
        });
      },
    },
    {
      id: 'bytes/write-bom-crlf',
      purpose: '整份覆写 BOM+CRLF 文件：BOM 保留，content 的 LF 适配成 CRLF，尾换行跟 content',
      input: 'BOM + "a\\r\\nb\\r\\n"；content = "A\\nB"（无尾换行）',
      expected: 'BOM + "A\\r\\nB"',
      async run(t) {
        const orig = bom('a\r\nb\r\n');
        t.write('f.txt', orig);
        await t.cliOk(['read', '--file', 'f.txt', '--mode', 'full']);
        await t.cliOk(['write', '--file', 'f.txt', '--content', 'A\nB']);
        const expected = Buffer.concat([BOM_BYTES, Buffer.from(adaptEol('A\nB', 'crlf'), 'utf8')]);
        t.eqBytes('file bytes match independent oracle', expected, t.read('f.txt'));
      },
    },
    {
      id: 'bytes/write-no-trailing-newline',
      purpose: '整份覆写时尾换行跟 content（文件原来有尾换行，content 没有 ⇒ 结果也没有）',
      input: '"a\\nb"（无尾换行）；content = "A\\nB\\n"（有尾换行）',
      expected: '"A\\nB\\n"',
      async run(t) {
        t.write('f.txt', Buffer.from('a\nb', 'utf8'));
        await t.cliOk(['read', '--file', 'f.txt', '--mode', 'full']);
        await t.cliOk(['write', '--file', 'f.txt', '--content', 'A\nB\n']);
        t.eqBytes('file bytes exactly equal content', Buffer.from('A\nB\n', 'utf8'), t.read('f.txt'));
      },
    },
  ],
};

function eolOf(eol) {
  if (!eol || eol.length === 0) return 'none';
  return eol[0] === 0x0d ? 'crlf' : 'lf';
}

function eolStyleOf(buf) {
  const styles = new Set(inspectBuffer(buf).lines.filter((l) => l.eol.length).map((l) => eolOf(l.eol)));
  if (styles.size === 0) return 'none';
  if (styles.size === 1) return [...styles][0];
  return 'mixed';
}

function countBareLf(buf) {
  const body = inspectBuffer(buf).body;
  let n = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === 0x0a && (i === 0 || body[i - 1] !== 0x0d)) n++;
  }
  return n;
}
