// Baseline comparison. The baseline here is written by THIS eval and is explicitly not
// the DSH built-in tools nor any other client:
//     whole-file readFileSync(utf8) + exact string replace + writeFileSync(utf8)
// Two labelled sub-variants are used where a naive tool would address by line instead:
//     text.split(/\r?\n/) -> replace one entry -> join('\n')
// Every row records both byte results; the report prints them.

import { inspectBuffer, naiveBaseline, replaceLineBuffer } from '../lib/harness.mjs';

function show(buf) {
  const hasBom = inspectBuffer(buf).hasBom;
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  const clipped = text.length > 90 ? `${text.slice(0, 90)}…` : text;
  return `${hasBom ? 'BOM+' : ''}${JSON.stringify(clipped)}`;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export const suite = {
  id: 'baseline',
  title: '基线对照（本测评自写的朴素实现；非 DSH 原生工具）',
  cases: [
    {
      id: 'baseline/bom-exact-token',
      purpose: 'BOM 文件 + 同长度 token 精确字符串替换：朴素「整读-替换-整写」是否破坏 BOM',
      input: 'BOM + "alpha beta\\n"；替换 beta→BETA',
      expected: '基线保留 BOM（Node utf8 往返保留 U+FEFF），两者字节一致',
      async run(t) {
        const orig = Buffer.concat([BOM, Buffer.from('alpha beta\n', 'utf8')]);
        t.write('baseline.txt', orig);
        t.write('aura.txt', orig);
        naiveBaseline.exactReplace(t.path('baseline.txt'), 'beta', 'BETA');
        await t.cliOk(['edit', '--file', 'aura.txt', '--old', 'beta', '--replace', 'BETA']);
        const b = t.read('baseline.txt');
        const a = t.read('aura.txt');
        t.eqBytes('aura bytes = oracle', Buffer.concat([BOM, Buffer.from('alpha BETA\n', 'utf8')]), a);
        t.eq('baseline agrees here (BOM survives Node utf8 round-trip)', true, b.equals(a));
        t.data = {
          scenario: 'BOM + 单行 token 精确替换',
          baselineText: show(b),
          auraText: show(a),
          same: b.equals(a),
          note: '两者一致：朴素基线在这个写法下不会破坏 BOM，本组不构成 aura 的优势证据',
        };
      },
    },
    {
      id: 'baseline/crlf-exact-token',
      purpose: 'CRLF 文件 + 不含换行的精确替换：朴素实现是否破坏 CRLF',
      input: 'CRLF 文件；替换 token→TOKEN（无换行）',
      expected: '基线保留 CRLF，两者字节一致',
      async run(t) {
        const orig = Buffer.from('one\r\ntwo\r\nthree\r\n', 'utf8');
        t.write('baseline.txt', orig);
        t.write('aura.txt', orig);
        naiveBaseline.exactReplace(t.path('baseline.txt'), 'two', 'TWO');
        await t.cliOk(['edit', '--file', 'aura.txt', '--old', 'two', '--replace', 'TWO']);
        const b = t.read('baseline.txt');
        const a = t.read('aura.txt');
        t.eq('baseline agrees here', true, b.equals(a));
        t.data = {
          scenario: 'CRLF + 单行 token 精确替换（替换文本无换行）',
          baselineText: show(b),
          auraText: show(a),
          same: b.equals(a),
          note: '两者一致：替换文本不含换行时，朴素实现不会改变行尾',
        };
      },
    },
    {
      id: 'baseline/no-trailing-newline-exact-token',
      purpose: '无尾换行文件 + 末行 token 替换：朴素实现是否补尾换行',
      input: '"a\\nb"（无尾换行）；替换 b→B',
      expected: '基线仍无尾换行，两者字节一致',
      async run(t) {
        const orig = Buffer.from('a\nb', 'utf8');
        t.write('baseline.txt', orig);
        t.write('aura.txt', orig);
        naiveBaseline.exactReplace(t.path('baseline.txt'), 'b', 'B');
        await t.cliOk(['edit', '--file', 'aura.txt', '--old', 'b', '--replace', 'B']);
        const b = t.read('baseline.txt');
        const a = t.read('aura.txt');
        t.eq('baseline agrees here', true, b.equals(a));
        t.data = {
          scenario: '无尾换行 + 末行 token 精确替换',
          baselineText: show(b),
          auraText: show(a),
          same: b.equals(a),
          note: '两者一致：纯字符串替换不会增删尾换行',
        };
      },
    },
    {
      id: 'baseline/bom-first-line-line-addressed',
      purpose: '按行寻址改第一行（朴素做法 split/join）：第一行的 BOM 会随「整行文本」一起被替换掉；aura 保留 BOM',
      input: 'BOM + "first\\nsecond\\n"；改第 1 行为 "FIRST"',
      expected: '基线丢 BOM（无 EF BB BF）；aura = BOM + "FIRST\\nsecond\\n"',
      async run(t) {
        const orig = Buffer.concat([BOM, Buffer.from('first\nsecond\n', 'utf8')]);
        t.write('baseline.txt', orig);
        t.write('aura.txt', orig);
        naiveBaseline.lineReplace(t.path('baseline.txt'), 1, 'FIRST');
        await t.cliOk(['edit', '--file', 'aura.txt', '--lines', '1', '--replace', 'FIRST']);
        const b = t.read('baseline.txt');
        const a = t.read('aura.txt');
        t.eq('baseline lost the BOM', false, inspectBuffer(b).hasBom);
        t.eq('aura kept the BOM', true, inspectBuffer(a).hasBom);
        t.eqBytes('aura bytes = oracle', replaceLineBuffer(orig, 1, 'FIRST'), a);
        t.eq('bytes differ', false, b.equals(a));
        t.data = {
          scenario: 'BOM 文件，按行寻址改第 1 行（朴素 split/join）',
          baselineText: show(b),
          auraText: show(a),
          same: b.equals(a),
          note: '差异真实存在：朴素按行寻址会把首行的 BOM 当作行内容替换掉',
        };
      },
    },
    {
      id: 'baseline/crlf-multiline-line-addressed',
      purpose: 'CRLF 文件里插入多行（朴素 split/join）：整文件行尾被改成 LF，且尾部多一个空行；aura 保持 CRLF',
      input: 'CRLF 3 行文件；第 2 行替换为 "P2a\\nP2b"',
      expected: '基线 = 全 LF + 尾换行；aura = 原 CRLF 结构 + 新行 CRLF',
      async run(t) {
        const orig = Buffer.from('p1\r\np2\r\np3\r\n', 'utf8');
        t.write('baseline.txt', orig);
        t.write('aura.txt', orig);
        naiveBaseline.lineReplace(t.path('baseline.txt'), 2, 'P2a\nP2b');
        await t.cliOk(['edit', '--file', 'aura.txt', '--lines', '2', '--replace', 'P2a\nP2b']);
        const b = t.read('baseline.txt');
        const a = t.read('aura.txt');
        t.eq('baseline CRLF count = 0', 0, countCrlf(b));
        t.eq('baseline now uses bare LF', true, countBareLf(b) > 0);
        t.eq('aura keeps 4 CRLF terminators', 4, countCrlf(a));
        t.eq('aura has no bare LF', 0, countBareLf(a));
        t.eq('baseline bytes differ', false, b.equals(a));
        t.eqBytes('aura bytes = oracle', Buffer.from('p1\r\nP2a\r\nP2b\r\np3\r\n', 'utf8'), a);
        t.data = {
          scenario: 'CRLF 文件，按行寻址插入多行（朴素 split/join）',
          baselineText: show(b),
          auraText: show(a),
          same: b.equals(a),
          note: '差异真实存在：split(/\\r?\\n/)+join("\\n") 把整文件行尾统一成 LF',
        };
      },
    },
    {
      id: 'baseline/stale-no-gate',
      purpose: '读后外部改同一行：朴素「读-改-写」没有陈旧闸，会覆盖外部写入；aura 拒绝且保留外部字节',
      input: '读 → 外部把第 2 行改为 k2-EXTERNAL → 两边都尝试把 k2 改成 K2',
      expected: '基线改写了外部内容；aura code=PATCH_STALE_REGION 且磁盘 = 外部版本',
      async run(t) {
        const orig = Buffer.from('k1\nk2\nk3\n', 'utf8');
        const external = Buffer.from('k1\nk2-EXTERNAL\nk3\n', 'utf8');
        t.write('aura.txt', orig);
        await t.cliOk(['read', '--file', 'aura.txt', '--mode', 'full']);
        // The naive writer decided its bytes from the content it read BEFORE the external
        // write (read-modify-write with no staleness check).
        const staleBytes = Buffer.from(orig.toString('utf8').replace('k2', 'K2'), 'utf8');
        t.write('baseline.txt', external); // the external writer lands first
        t.write('baseline.txt', staleBytes); // then the naive writer writes its stale result
        t.write('aura.txt', external);
        const r = await t.cli(['edit', '--file', 'aura.txt', '--lines', '2', '--replace', 'K2']);
        const b = t.read('baseline.txt');
        const a = t.read('aura.txt');
        t.eq('aura refuses with PATCH_STALE_REGION', 'PATCH_STALE_REGION', r.json?.code);
        t.eqBytes('aura disk = external bytes', external, a);
        t.eq('baseline clobbered the external edit', false, b.equals(external));
        t.eqBytes('baseline wrote its stale version', Buffer.from('k1\nK2\nk3\n', 'utf8'), b);
        t.data = {
          scenario: '读后外部改同一区域（陈旧安全）',
          baselineText: show(b),
          auraText: show(a),
          same: b.equals(a),
          note: '差异真实存在：基线没有陈旧闸，按陈旧文本重写；aura 拒绝且磁盘保持外部版本',
        };
      },
    },
    {
      id: 'baseline/multi-target-partial',
      purpose: '两个目标的第二批失败：朴素实现先写成功的再抛错（部分写入）；aura 整批零写入',
      input: 'a.txt 合法 + b.txt 行号越界；分别用朴素顺序写与 aura --targets',
      expected: '基线 a.txt 已被改（部分写入）；aura 两个文件都不变',
      async run(t) {
        const aOrig = Buffer.from('a1\na2\n', 'utf8');
        const bOrig = Buffer.from('b1\nb2\n', 'utf8');
        t.write('a.txt', aOrig);
        t.write('b.txt', bOrig);
        // naive: write the first target, then fail on the second (out of range -> throw)
        naiveBaseline.lineReplace(t.path('a.txt'), 1, 'A1');
        let baselineThrew = false;
        try {
          const bLines = naiveBaseline.lineReplace(t.path('b.txt'), 9, 'Z');
          baselineThrew = bLines === undefined;
        } catch {
          baselineThrew = true;
        }
        const afterBaselineA = t.read('a.txt');
        // reset BOTH files: the naive lineReplace above also rewrote b.txt (appending blank
        // lines), so without the reset the aura target would no longer be out of range.
        t.write('a.txt', aOrig);
        t.write('b.txt', bOrig);
        const r = await t.cli([
          'edit',
          '--targets',
          JSON.stringify([
            { file_path: 'a.txt', hunks: [{ lines: [1, 1], replace: 'A1' }] },
            { file_path: 'b.txt', hunks: [{ lines: [9, 9], replace: 'Z' }] },
          ]),
        ]);
        t.eq('baseline threw on the second target', true, baselineThrew);
        t.eq('baseline had already written the first target', false, afterBaselineA.equals(aOrig));
        t.eq('aura exit=2', 2, r.code);
        t.eq('aura b.txt untouched', true, t.read('b.txt').equals(bOrig));
        t.eqBytes('aura a.txt unchanged', aOrig, t.read('a.txt'));
        t.eqBytes('aura b.txt unchanged', bOrig, t.read('b.txt'));
        t.data = {
          scenario: '多目标，第二项规划失败（原子性）',
          baselineText: show(afterBaselineA),
          auraText: show(t.read('a.txt')),
          same: afterBaselineA.equals(t.read('a.txt')),
          note: '差异真实存在：朴素顺序写会留下部分写入；aura 整批零写入',
        };
      },
    },
  ],
};

function countBareLf(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) n++;
  return n;
}
function countCrlf(buf) {
  let n = 0;
  for (let i = 1; i < buf.length; i++) if (buf[i] === 0x0a && buf[i - 1] === 0x0d) n++;
  return n;
}
function countCrlfBytePairs(buf) {
  return countBareLf(buf) === 0 && countCrlf(buf) > 0 ? countCrlf(buf) * 2 : 0;
}
