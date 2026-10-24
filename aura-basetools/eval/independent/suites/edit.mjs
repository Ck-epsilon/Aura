// Edit semantics: addresses (lines / line_cue / anchor / target / old), replace_all,
// expect, dry-run. Every expected file is rebuilt by this suite from Buffers.

import { inspectBuffer, replaceLineBuffer, replaceRangeBuffer } from '../lib/harness.mjs';

const read = (t, name) => t.read(name);

export const suite = {
  id: 'edit',
  title: '编辑语义（lines / line_cue / anchor / target / old / expect / replace_all / dry-run）',
  cases: [
    {
      id: 'edit/lines-single',
      purpose: 'lines 单行：只替换该行内容，行尾与其它行字节不变',
      input: '"one\\ntwo\\nthree\\n"，lines=2 → "TWO"',
      expected: '"one\\nTWO\\nthree\\n"',
      async run(t) {
        const orig = Buffer.from('one\ntwo\nthree\n', 'utf8');
        t.write('f.txt', orig);
        const r = await t.cliOk(['edit', '--file', 'f.txt', '--lines', '2', '--replace', 'TWO']);
        t.eqBytes('file matches oracle', replaceLineBuffer(orig, 2, 'TWO'), read(t, 'f.txt'));
        t.eq('receipt line=2', 2, r.json?.result?.applied?.[0]?.line);
        t.eq('receipt actual=two', 'two', r.json?.result?.applied?.[0]?.actual);
      },
    },
    {
      id: 'edit/lines-range-collapse',
      purpose: 'lines 区间 [2,3] 折叠成一行：新行保留区间末行的行尾，其余行不动',
      input: '"a\\nb\\nc\\nd\\n"，lines=2-3 → "BC"',
      expected: '"a\\nBC\\nd\\n"',
      async run(t) {
        const orig = Buffer.from('a\nb\nc\nd\n', 'utf8');
        t.write('f.txt', orig);
        await t.cliOk(['edit', '--file', 'f.txt', '--start-line', '2', '--end-line', '3', '--replace', 'BC']);
        t.eqBytes('file matches oracle', replaceRangeBuffer(orig, 2, 3, 'BC'), read(t, 'f.txt'));
      },
    },
    {
      id: 'edit/lines-range-expand',
      purpose: 'lines 区间 [2,2] 替换为两行文本（含 \\n）：新行按 eol=auto 使用文件风格',
      input: 'LF 文件，lines=2 → "B1\\nB2"',
      expected: '"a\\nB1\\nB2\\nc\\n"',
      async run(t) {
        const orig = Buffer.from('a\nb\nc\n', 'utf8');
        t.write('f.txt', orig);
        await t.cliOk(['edit', '--file', 'f.txt', '--lines', '2', '--replace', 'B1\nB2']);
        t.eqBytes('file matches oracle', replaceRangeBuffer(orig, 2, 2, 'B1\nB2'), read(t, 'f.txt'));
      },
    },
    {
      id: 'edit/line-cue',
      purpose: 'line_cue 唯一词：定位到含该词的行并整行替换',
      input: '"alpha one\\nbeta two\\ngamma three\\n"，line_cue=gamma → "GAMMA"',
      expected: '"alpha one\\nbeta two\\nGAMMA\\n"',
      async run(t) {
        const orig = Buffer.from('alpha one\nbeta two\ngamma three\n', 'utf8');
        t.write('f.txt', orig);
        const r = await t.cliOk(['edit', '--file', 'f.txt', '--line-cue', 'gamma', '--replace', 'GAMMA']);
        t.eqBytes('file matches oracle', replaceLineBuffer(orig, 3, 'GAMMA'), read(t, 'f.txt'));
        t.eq('receipt tier=lineCue', 'lineCue', r.json?.result?.applied?.[0]?.tier);
      },
    },
    {
      id: 'edit/anchor',
      purpose: 'anchor 记忆原文（整行）：定位并整行替换',
      input: '"alpha one\\nbeta two\\ngamma three\\n"，anchor="beta two" → "BETA"',
      expected: '"alpha one\\nBETA\\ngamma three\\n"',
      async run(t) {
        const orig = Buffer.from('alpha one\nbeta two\ngamma three\n', 'utf8');
        t.write('f.txt', orig);
        await t.cliOk(['edit', '--file', 'f.txt', '--anchor', 'beta two', '--replace', 'BETA']);
        t.eqBytes('file matches oracle', replaceLineBuffer(orig, 2, 'BETA'), read(t, 'f.txt'));
      },
    },
    {
      id: 'edit/anchor-multi-line',
      purpose: 'anchor 跨行的记忆原文：命中多行区域并整段替换（不靠行号）',
      input: '"head\\nA\\nB\\ntail\\n"，anchor="A\\nB" → "X\\nY"',
      expected: '"head\\nX\\nY\\ntail\\n"',
      async run(t) {
        const orig = Buffer.from('head\nA\nB\ntail\n', 'utf8');
        t.write('f.txt', orig);
        await t.cliOk(['edit', '--file', 'f.txt', '--anchor', 'A\nB', '--replace', 'X\nY']);
        t.eqBytes('file matches oracle', replaceRangeBuffer(orig, 2, 3, 'X\nY'), read(t, 'f.txt'));
      },
    },
    {
      id: 'edit/target-symbol',
      purpose: 'target 按符号名改整个函数体：不读文本，替换声明跨度',
      input: 'function alpha 行 1-3；target=alpha → 三行新函数体',
      expected: '文件 = "export function alpha() {\\n  return 99;\\n}\\n\\nconst beta = 2;\\n"',
      async run(t) {
        const body = 'export function alpha() {\n  return 99;\n}';
        const orig = Buffer.from(`export function alpha() {\n  return 1;\n}\n\nconst beta = 2;\n`, 'utf8');
        t.write('f.mjs', orig);
        const r = await t.cliOk(['edit', '--file', 'f.mjs', '--hunks', JSON.stringify([{ target: 'alpha', replace: body }])]);
        t.eqBytes('file matches oracle', replaceRangeBuffer(orig, 1, 3, body), read(t, 'f.mjs'));
        t.eq('receipt tier=symbol', 'symbol', r.json?.result?.applied?.[0]?.tier);
        t.eq('receipt delta=0', 0, r.json?.result?.applied?.[0]?.delta);
      },
    },
    {
      id: 'edit/old-fragment',
      purpose: 'old 命中行内一段：只替换该片段，整行其余字节保持（片段层语义）',
      input: '"keep AA keep\\n"，old=AA → BB',
      expected: '"keep BB keep\\n"',
      async run(t) {
        const orig = Buffer.from('keep AA keep\n', 'utf8');
        t.write('f.txt', orig);
        await t.cliOk(['edit', '--file', 'f.txt', '--old', 'AA', '--replace', 'BB']);
        t.eqBytes('file matches oracle', Buffer.from('keep BB keep\n', 'utf8'), read(t, 'f.txt'));
      },
    },
    {
      id: 'edit/replace-all-nonoverlap',
      purpose: 'replace_all 非重叠左到右："aa" 在 "aaaa" 上是 2 处（不是 3 处），回执逐处给列位置',
      input: '"aaaa\\n"，old=aa replace=X replace_all',
      expected: '"XX\\n"；applied 长度 2',
      async run(t) {
        const orig = Buffer.from('aaaa\n', 'utf8');
        t.write('f.txt', orig);
        const r = await t.cliOk(['edit', '--file', 'f.txt', '--old', 'aa', '--replace', 'X', '--replace-all']);
        t.eqBytes('file matches oracle', Buffer.from('XX\n', 'utf8'), read(t, 'f.txt'));
        t.eq('two applied entries', 2, r.json?.result?.applied?.length);
      },
    },
    {
      id: 'edit/replace-all-count-stable',
      purpose: 'replace_all 出现次数未变（只改了无关行）：应放行并按当前磁盘改全部出现',
      input: '读后外部把第 2 行从 bb 改成 bb-extra（aa 次数不变），再 old=aa replace_all',
      expected: '成功；所有 aa 变成 X；第 2 行仍是 bb-extra',
      async run(t) {
        const orig = Buffer.from('aa\nbb\naa\n', 'utf8');
        t.write('f.txt', orig);
        await t.cliOk(['read', '--file', 'f.txt', '--mode', 'full']);
        t.write('f.txt', Buffer.from('aa\nbb-extra\naa\n', 'utf8'));
        await t.cliOk(['edit', '--file', 'f.txt', '--old', 'aa', '--replace', 'X', '--replace-all']);
        const expected = Buffer.from('X\nbb-extra\nX\n', 'utf8');
        t.eqBytes('file matches oracle (external non-overlap edit preserved)', expected, read(t, 'f.txt'));
      },
    },
    {
      id: 'edit/replace-all-count-changed',
      purpose: 'replace_all 读后出现次数变了：必须整体拒绝 PATCH_STALE_REGION，附带 occurrence_count {was,now}，磁盘不变',
      input: '读 "aa\\nbb\\naa\\n"（2 处）后外部追加一行 aa（3 处）',
      expected: '拒绝；code=PATCH_STALE_REGION；occurrence_count.was=2 now=3；磁盘字节 = 外部版本',
      async run(t) {
        t.write('f.txt', Buffer.from('aa\nbb\naa\n', 'utf8'));
        await t.cliOk(['read', '--file', 'f.txt', '--mode', 'full']);
        const external = Buffer.from('aa\nbb\naa\naa\n', 'utf8');
        t.write('f.txt', external);
        const r = await t.cli(['edit', '--file', 'f.txt', '--old', 'aa', '--replace', 'X', '--replace-all']);
        t.eq('exit=2', 2, r.code);
        t.eq('code=PATCH_STALE_REGION', 'PATCH_STALE_REGION', r.json?.code);
        t.eq('occurrence_count.was=2', 2, r.json?.occurrence_count?.was);
        t.eq('occurrence_count.now=3', 3, r.json?.occurrence_count?.now);
        t.eqBytes('disk unchanged (external bytes intact)', external, read(t, 'f.txt'));
      },
    },
    {
      id: 'edit/replace-all-newline-old-refused',
      purpose: 'replace_all 的 old 带尾换行：按公开承诺拒绝（避免 old:"a\\n" 退化成匹配 banana），磁盘不变',
      input: '"a\\nb\\n"，old="a\\n" replace_all',
      expected: 'code=PATCH_REPLACE_ALL_CONFLICT；磁盘不变',
      async run(t) {
        const orig = Buffer.from('a\nb\n', 'utf8');
        t.write('f.txt', orig);
        const r = await t.cli(['edit', '--file', 'f.txt', '--old', 'a\n', '--replace', 'Z', '--replace-all']);
        t.eq('code=PATCH_REPLACE_ALL_CONFLICT', 'PATCH_REPLACE_ALL_CONFLICT', r.json?.code);
        t.eqBytes('disk unchanged', orig, read(t, 'f.txt'));
      },
    },
    {
      id: 'edit/replace-all-address-conflict',
      purpose: 'replace_all 与 target 同用：收敛地址与全改无共同答案，必须拒绝',
      input: '--target + --old + --replace-all',
      expected: 'code=PATCH_REPLACE_ALL_CONFLICT；磁盘不变',
      async run(t) {
        const orig = Buffer.from('aaaa\n', 'utf8');
        t.write('f.txt', orig);
        const r = await t.cli(['edit', '--file', 'f.txt', '--target', 'x', '--old', 'aa', '--replace', 'X', '--replace-all']);
        t.eq('code=PATCH_REPLACE_ALL_CONFLICT', 'PATCH_REPLACE_ALL_CONFLICT', r.json?.code);
        t.eqBytes('disk unchanged', orig, read(t, 'f.txt'));
      },
    },
    {
      id: 'edit/expect-mismatch',
      purpose: 'expect 与寻址区域不符：整批拒绝，磁盘一个字节都不动',
      input: '读后 lines=2 expect="WRONG"',
      expected: 'code=LOCATOR_ASSERT_MISMATCH；磁盘不变',
      async run(t) {
        const orig = Buffer.from('one\ntwo\nthree\n', 'utf8');
        t.write('f.txt', orig);
        await t.cliOk(['read', '--file', 'f.txt', '--mode', 'full']);
        const r = await t.cli(['edit', '--file', 'f.txt', '--lines', '2', '--expect', 'WRONG', '--replace', 'X']);
        t.eq('code=LOCATOR_ASSERT_MISMATCH', 'LOCATOR_ASSERT_MISMATCH', r.json?.code);
        t.eqBytes('disk unchanged', orig, read(t, 'f.txt'));
      },
    },
    {
      id: 'edit/expect-match',
      purpose: 'expect 与区域一致：正常落盘',
      input: '读后 lines=2 expect=two → TWO',
      expected: '"one\\nTWO\\nthree\\n"',
      async run(t) {
        const orig = Buffer.from('one\ntwo\nthree\n', 'utf8');
        t.write('f.txt', orig);
        await t.cliOk(['read', '--file', 'f.txt', '--mode', 'full']);
        await t.cliOk(['edit', '--file', 'f.txt', '--lines', '2', '--expect', 'two', '--replace', 'TWO']);
        t.eqBytes('file matches oracle', replaceLineBuffer(orig, 2, 'TWO'), read(t, 'f.txt'));
      },
    },
    {
      id: 'edit/dry-run-no-write',
      purpose: 'dry-run 只规划不落盘，且不铸可复用句柄',
      input: 'lines=2 → TWO，--dry-run',
      expected: '磁盘不变；回执 dryRun=true；applied[0] 无 handle',
      async run(t) {
        const orig = Buffer.from('one\ntwo\nthree\n', 'utf8');
        t.write('f.txt', orig);
        const r = await t.cliOk(['edit', '--file', 'f.txt', '--lines', '2', '--replace', 'TWO', '--dry-run']);
        t.eqBytes('disk unchanged', orig, read(t, 'f.txt'));
        t.eq('receipt dryRun=true', true, r.json?.result?.dryRun);
        t.eq('no handle minted by dry-run', undefined, r.json?.result?.applied?.[0]?.handle);
        t.eq('planned text still reported', 'TWO', r.json?.result?.applied?.[0]?.replaced);
      },
    },
    {
      id: 'edit/plan-no-write',
      purpose: '--plan 等价于 dry-run：零写入',
      input: 'lines=1 → ONE，--plan',
      expected: '磁盘不变',
      async run(t) {
        const orig = Buffer.from('one\ntwo\n', 'utf8');
        t.write('f.txt', orig);
        const r = await t.cliOk(['edit', '--file', 'f.txt', '--lines', '1', '--replace', 'ONE', '--plan']);
        t.eqBytes('disk unchanged', orig, read(t, 'f.txt'));
        t.eq('receipt dryRun=true', true, r.json?.result?.dryRun);
      },
    },
    {
      id: 'edit/unknown-flag-refused',
      purpose: '未知旗标（--dryrun）必须拒绝而不是被静默吞掉，且零写入',
      input: '--dryrun',
      expected: 'exit=1；shape=ARGS_UNKNOWN_KEY；磁盘不变',
      async run(t) {
        const orig = Buffer.from('one\ntwo\n', 'utf8');
        t.write('f.txt', orig);
        const r = await t.cli(['edit', '--file', 'f.txt', '--lines', '1', '--replace', 'X', '--dryrun']);
        t.eq('exit=1', 1, r.code);
        t.eq('shape=ARGS_UNKNOWN_KEY', 'ARGS_UNKNOWN_KEY', r.json?.shape);
        t.eqBytes('disk unchanged', orig, read(t, 'f.txt'));
      },
    },
    {
      id: 'edit/bad-eol-refused',
      purpose: '非法 eol 值必须拒绝（不静默降级），且零写入',
      input: '--eol bogus',
      expected: 'code=PATCH_BAD_EOL；磁盘不变',
      async run(t) {
        const orig = Buffer.from('one\ntwo\n', 'utf8');
        t.write('f.txt', orig);
        const r = await t.cli(['edit', '--file', 'f.txt', '--lines', '1', '--replace', 'X', '--eol', 'bogus']);
        t.eq('code=PATCH_BAD_EOL', 'PATCH_BAD_EOL', r.json?.code);
        t.eqBytes('disk unchanged', orig, read(t, 'f.txt'));
      },
    },
    {
      id: 'edit/multi-hunk-single-call',
      purpose: '一次调用两个 hunk：都对同一份原文件规划，行号互不叠加（回执 line 为改前行号）',
      input: '"L1\\nL2\\nL3\\n"，hunks=[{lines:[1,1]},{lines:[3,3]}]',
      expected: '"L1x\\nL2\\nL3x\\n"；applied[].line = [1,3]',
      async run(t) {
        const orig = Buffer.from('L1\nL2\nL3\n', 'utf8');
        t.write('f.txt', orig);
        const hunks = [
          { lines: [1, 1], replace: 'L1x' },
          { lines: [3, 3], replace: 'L3x' },
        ];
        const r = await t.cliOk(['edit', '--file', 'f.txt', '--hunks', JSON.stringify(hunks)]);
        t.eqBytes('file matches oracle', Buffer.from('L1x\nL2\nL3x\n', 'utf8'), read(t, 'f.txt'));
        t.deepEq('receipt pre-edit line numbers', [1, 3], (r.json?.result?.applied ?? []).map((a) => a.line));
        t.deepEq('receipt afterLine shifted by deltas', [1, 3], (r.json?.result?.applied ?? []).map((a) => a.afterLine));
      },
    },
    {
      id: 'edit/handle-range',
      purpose: 'handle 整段替换：区间由读回执的句柄定，不靠转述；区间内多行被一个替换文本取代',
      input: '4 行文件，读 lines=1-2 得 handle → --handle --replace NEW',
      expected: '"NEW\\nl3\\nl4\\n"；回执 tier=handle',
      async run(t) {
        const orig = Buffer.from('l1\nl2\nl3\nl4\n', 'utf8');
        t.write('f.txt', orig);
        const rd = await t.cliOk(['read', '--file', 'f.txt', '--mode', 'lines', '--lines', '1-2']);
        const handle = rd.json?.handle;
        t.check('read issues a handle for 1-2', typeof handle === 'string' && /:1-2$/.test(handle), { expected: 'h…:1-2', actual: handle });
        const r = await t.cliOk(['edit', '--file', 'f.txt', '--handle', handle, '--replace', 'NEW']);
        t.eqBytes('file matches oracle', replaceRangeBuffer(orig, 1, 2, 'NEW'), t.read('f.txt'));
        t.eq('receipt tier=handle', 'handle', r.json?.result?.applied?.[0]?.tier);
      },
    },
    {
      id: 'edit/handle-line',
      purpose: 'handle + line：只替换句柄区间内的第 k 行，区间其它行不动',
      input: '读 lines=1-3 得 handle → --handle --line 2 --replace MID',
      expected: '"l1\\nMID\\nl3\\nl4\\n"',
      async run(t) {
        const orig = Buffer.from('l1\nl2\nl3\nl4\n', 'utf8');
        t.write('f.txt', orig);
        const rd = await t.cliOk(['read', '--file', 'f.txt', '--mode', 'lines', '--lines', '1-3']);
        const r = await t.cliOk(['edit', '--file', 'f.txt', '--handle', rd.json?.handle, '--line', '2', '--replace', 'MID']);
        t.eqBytes('file matches oracle', replaceLineBuffer(orig, 2, 'MID'), t.read('f.txt'));
        t.eq('receipt actual=l2', 'l2', r.json?.result?.applied?.[0]?.actual);
      },
    },
    {
      id: 'edit/handle-stale-refused',
      purpose: '用过一次的句柄在文件变化后必须失效（PATCH_HANDLE_STALE），零写入；不能把旧坐标当新坐标用',
      input: '读 lines=1-2 得 handle → 第一次用它替换成功 → 同一 handle 再用一次',
      expected: '第二次 exit=2；code=PATCH_HANDLE_STALE；磁盘 = 第一次编辑后的字节',
      async run(t) {
        const orig = Buffer.from('l1\nl2\nl3\n', 'utf8');
        t.write('f.txt', orig);
        const rd = await t.cliOk(['read', '--file', 'f.txt', '--mode', 'lines', '--lines', '1-2']);
        const handle = rd.json?.handle;
        await t.cliOk(['edit', '--file', 'f.txt', '--handle', handle, '--replace', 'NEW']);
        const afterFirst = replaceRangeBuffer(orig, 1, 2, 'NEW');
        t.eqBytes('first edit landed', afterFirst, t.read('f.txt'));
        const r = await t.cli(['edit', '--file', 'f.txt', '--handle', handle, '--replace', 'AGAIN']);
        t.eq('exit=2', 2, r.code);
        t.eq('code=PATCH_HANDLE_STALE', 'PATCH_HANDLE_STALE', r.json?.code);
        t.eqBytes('disk unchanged since first edit', afterFirst, t.read('f.txt'));
      },
    },
    {
      id: 'edit/eol-lf-forced',
      purpose: 'eol=lf 显式强制：CRLF 文件里替换文本写成 LF（调用方显式选择，不是默认行为）',
      input: 'CRLF 文件，lines=2 → "P2a\\nP2b"，--eol lf',
      expected: '该行内部为 LF；其余行仍 CRLF',
      async run(t) {
        const orig = Buffer.from('p1\r\np2\r\np3\r\n', 'utf8');
        t.write('f.txt', orig);
        const r = await t.cliOk(['edit', '--file', 'f.txt', '--lines', '2', '--replace', 'P2a\nP2b', '--eol', 'lf']);
        const expected = replaceLineBuffer(orig, 2, 'P2a\nP2b');
        t.eqBytes('file matches oracle', expected, read(t, 'f.txt'));
        const insp = inspectBuffer(t.read('f.txt'));
        // eol=lf forces the newline INSIDE the replacement to LF, while the addressed
        // region's own terminator (the CRLF after p2) is still kept byte-for-byte.
        t.deepEq(
          'per-line eol = [crlf, lf, crlf, crlf, none]',
          ['crlf', 'lf', 'crlf', 'crlf', 'none'],
          insp.lines.map((l) => (l.eol.length === 0 ? 'none' : l.eol[0] === 0x0d ? 'crlf' : 'lf')),
        );
        t.check('receipt discloses no adaptation claim', r.json?.ok === true, { expected: true, actual: r.json?.ok });
      },
    },
  ],
};
