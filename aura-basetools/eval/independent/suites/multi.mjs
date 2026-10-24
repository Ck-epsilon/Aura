// Multi-target atomicity: one target that fails to plan must leave every other target
// untouched (the public promise is all-or-nothing per call).

import { replaceLineBuffer } from '../lib/harness.mjs';

const targets = (list) => JSON.stringify(list);
const tgt = (file, hunks) => ({ file_path: file, hunks });

export const suite = {
  id: 'multi',
  title: '多目标原子性（targets：一个规划失败 ⇒ 其他文件零写入；成功时逐项落地）',
  cases: [
    {
      id: 'multi/happy-two-files',
      purpose: '两个文件各改一行：两边都按 oracle 落盘',
      input: 'a.txt / b.txt 各 lines=1 替换',
      expected: '两个文件字节都 = oracle',
      async run(t) {
        t.write('a.txt', Buffer.from('a1\na2\n', 'utf8'));
        t.write('b.txt', Buffer.from('b1\nb2\n', 'utf8'));
        const r = await t.cliOk([
          'edit',
          '--targets',
          targets([tgt('a.txt', [{ lines: [1, 1], replace: 'A1' }]), tgt('b.txt', [{ lines: [1, 1], replace: 'B1' }])]),
        ]);
        t.eqBytes('a.txt matches oracle', Buffer.from('A1\na2\n', 'utf8'), t.read('a.txt'));
        t.eqBytes('b.txt matches oracle', Buffer.from('B1\nb2\n', 'utf8'), t.read('b.txt'));
        t.eq('receipt targets=2', 2, r.json?.targets);
      },
    },
    {
      id: 'multi/plan-failure-zero-writes',
      purpose: '第 2 个 target 行号越界：第 1 个 target 必须零写入（不是「先写成功的那个」）',
      input: 'a.txt 合法 + b.txt lines=9（越界）',
      expected: 'exit=2；applied=0；unchanged=true；landed_paths=[]；两个文件字节都不变',
      async run(t) {
        const a = Buffer.from('a1\na2\n', 'utf8');
        const b = Buffer.from('b1\nb2\n', 'utf8');
        t.write('a.txt', a);
        t.write('b.txt', b);
        const r = await t.cli([
          'edit',
          '--targets',
          targets([tgt('a.txt', [{ lines: [1, 1], replace: 'A1' }]), tgt('b.txt', [{ lines: [9, 9], replace: 'Z' }])]),
        ]);
        t.eq('exit=2', 2, r.code);
        t.eq('receipt ok=false', false, r.json?.ok);
        t.eq('applied=0', 0, r.json?.applied);
        t.eq('unchanged=true', true, r.json?.unchanged);
        t.deepEq('landed_paths empty', [], r.json?.landed_paths);
        t.eqBytes('a.txt untouched', a, t.read('a.txt'));
        t.eqBytes('b.txt untouched', b, t.read('b.txt'));
      },
    },
    {
      id: 'multi/expect-failure-zero-writes',
      purpose: '第 2 个 target 的 expect 不匹配：同样整批零写入',
      input: 'a.txt 合法 + b.txt expect=NOPE',
      expected: '两个文件字节都不变',
      async run(t) {
        const a = Buffer.from('a1\na2\n', 'utf8');
        const b = Buffer.from('b1\nb2\n', 'utf8');
        t.write('a.txt', a);
        t.write('b.txt', b);
        const r = await t.cli([
          'edit',
          '--targets',
          targets([
            tgt('a.txt', [{ lines: [1, 1], replace: 'A1' }]),
            tgt('b.txt', [{ lines: [1, 1], expect: 'NOPE', replace: 'B1' }]),
          ]),
        ]);
        t.eq('exit=2', 2, r.code);
        t.eq('applied=0', 0, r.json?.applied);
        t.eqBytes('a.txt untouched', a, t.read('a.txt'));
        t.eqBytes('b.txt untouched', b, t.read('b.txt'));
      },
    },
    {
      id: 'multi/missing-file-zero-writes',
      purpose: '第 2 个 target 文件不存在：第 1 个 target 必须零写入',
      input: 'a.txt 合法 + missing.txt',
      expected: 'a.txt 字节不变；结构化失败（非崩溃）',
      async run(t) {
        const a = Buffer.from('a1\na2\n', 'utf8');
        t.write('a.txt', a);
        const r = await t.cli([
          'edit',
          '--targets',
          targets([tgt('a.txt', [{ lines: [1, 1], replace: 'A1' }]), tgt('missing.txt', [{ lines: [1, 1], replace: 'M' }])]),
        ]);
        t.eq('exit=2', 2, r.code);
        t.eq('receipt ok=false', false, r.json?.ok);
        t.eqBytes('a.txt untouched', a, t.read('a.txt'));
        t.eq('missing.txt still absent', false, t.exists('missing.txt'));
      },
    },
    {
      id: 'multi/dry-run-zero-writes',
      purpose: '多目标 dry_run：完整规划但不落盘',
      input: 'a.txt + b.txt，--dry-run',
      expected: '两个文件字节都不变；回执 dryRun=true',
      async run(t) {
        const a = Buffer.from('a1\n', 'utf8');
        const b = Buffer.from('b1\n', 'utf8');
        t.write('a.txt', a);
        t.write('b.txt', b);
        const r = await t.cliOk([
          'edit',
          '--dry-run',
          '--targets',
          targets([tgt('a.txt', [{ lines: [1, 1], replace: 'A1' }]), tgt('b.txt', [{ lines: [1, 1], replace: 'B1' }])]),
        ]);
        t.eqBytes('a.txt untouched', a, t.read('a.txt'));
        t.eqBytes('b.txt untouched', b, t.read('b.txt'));
        t.eq('receipt dryRun=true', true, r.json?.dryRun);
      },
    },
    {
      id: 'multi/same-file-two-targets',
      purpose: '同一文件出现两次（两次改不同行）：两个 hunk 都要落地，且磁盘 = oracle',
      input: 'a.txt 两个 target 分别改行 1 与行 3',
      expected: '两行都改；磁盘 = oracle',
      async run(t) {
        const a = Buffer.from('a1\na2\na3\n', 'utf8');
        t.write('a.txt', a);
        await t.cliOk([
          'edit',
          '--targets',
          targets([tgt('a.txt', [{ lines: [1, 1], replace: 'A1' }]), tgt('a.txt', [{ lines: [3, 3], replace: 'A3' }])]),
        ]);
        let expected = replaceLineBuffer(a, 1, 'A1');
        expected = replaceLineBuffer(expected, 3, 'A3');
        t.eqBytes('file matches oracle', expected, t.read('a.txt'));
      },
    },
  ],
};
