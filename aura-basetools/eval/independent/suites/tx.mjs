// Cross-call transactions: begin → edit --tx → commit / rollback, commit --verify failure
// rollback, three-way merge of non-overlapping external edits, TX_CONFLICT on overlap.
// Note: `edit --tx` writes to disk immediately; the transaction log is what can restore it.

import { replaceLineBuffer } from '../lib/harness.mjs';

const VERIFY_FAIL = 'node -e "process.exit(1)"';

function beginId(r) {
  return r.json?.transaction?.id ?? null;
}

export const suite = {
  id: 'tx',
  title: '跨调用事务（begin / edit --tx / commit / rollback / verify 失败回滚 / 外部改动合并 / TX_CONFLICT）',
  cases: [
    {
      id: 'tx/commit-happy',
      purpose: 'begin → 两次 edit --tx（不同行）→ commit：两次修改都落盘，事务状态 committed',
      input: '"T1\\nT2\\nT3\\n"，tx 改行 1 与行 3',
      expected: '磁盘 = "T1x\\nT2\\nT3x\\n"；status=committed',
      async run(t) {
        const orig = Buffer.from('T1\nT2\nT3\n', 'utf8');
        t.write('t.txt', orig);
        await t.cliOk(['read', '--file', 't.txt', '--mode', 'full']);
        const b = await t.cliOk(['tx', 'begin']);
        const id = beginId(b);
        t.check('tx begin returns an id', typeof id === 'string' && id.length > 0, { expected: 'non-empty id', actual: id });
        await t.cliOk(['edit', '--file', 't.txt', '--lines', '1', '--replace', 'T1x', '--tx', id]);
        await t.cliOk(['edit', '--file', 't.txt', '--lines', '3', '--replace', 'T3x', '--tx', id]);
        const c = await t.cliOk(['tx', 'commit', '--id', id]);
        t.eq('transaction status=committed', 'committed', c.json?.transaction?.status);
        let expected = replaceLineBuffer(orig, 1, 'T1x');
        expected = replaceLineBuffer(expected, 3, 'T3x');
        t.eqBytes('file matches oracle', expected, t.read('t.txt'));
      },
    },
    {
      id: 'tx/rollback-restores-bytes',
      purpose: 'rollback 必须把每个文件恢复到事务前字节（含 CRLF/BOM 这类格式细节）',
      input: 'BOM + CRLF 文件，tx 改行 2 → rollback',
      expected: '磁盘字节 = 事务前原始字节（逐字节）',
      async run(t) {
        const orig = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\nc\r\n', 'utf8')]);
        t.write('t.txt', orig);
        await t.cliOk(['read', '--file', 't.txt', '--mode', 'full']);
        const b = await t.cliOk(['tx', 'begin']);
        const id = beginId(b);
        await t.cliOk(['edit', '--file', 't.txt', '--lines', '2', '--replace', 'B', '--tx', id]);
        t.eqBytes('tx edit landed before rollback', replaceLineBuffer(orig, 2, 'B'), t.read('t.txt'));
        const r = await t.cliOk(['tx', 'rollback', '--id', id]);
        t.eq('rollback status=rolled_back', 'rolled_back', r.json?.rollback?.status);
        t.eqBytes('original bytes restored exactly', orig, t.read('t.txt'));
      },
    },
    {
      id: 'tx/commit-verify-failure-rolls-back',
      purpose: 'commit --verify 非零退出：整个事务回滚，磁盘回到事务前字节，回执带 PATCH_VERIFY_FAILED',
      input: 'tx 改行 1；commit --verify "node -e \\"process.exit(1)\\""',
      expected: 'exit=2；code=PATCH_VERIFY_FAILED；rollback.status=rolled_back；磁盘 = 原始字节',
      async run(t) {
        const orig = Buffer.from('v1\nv2\n', 'utf8');
        t.write('t.txt', orig);
        await t.cliOk(['read', '--file', 't.txt', '--mode', 'full']);
        const b = await t.cliOk(['tx', 'begin']);
        const id = beginId(b);
        await t.cliOk(['edit', '--file', 't.txt', '--lines', '1', '--replace', 'v1x', '--tx', id]);
        const r = await t.cli(['tx', 'commit', '--id', id, '--verify', VERIFY_FAIL]);
        t.eq('exit=2', 2, r.code);
        t.eq('code=PATCH_VERIFY_FAILED', 'PATCH_VERIFY_FAILED', r.json?.code);
        t.eq('verification exitCode=1', 1, r.json?.verification?.exitCode);
        t.eq('rollback.status=rolled_back', 'rolled_back', r.json?.rollback?.status);
        t.eqBytes('original bytes restored', orig, t.read('t.txt'));
      },
    },
    {
      id: 'tx/external-nonoverlap-merge',
      purpose: 'commit 前外部改了别的行：三方合并应同时保留外部改动与事务改动',
      input: 'tx 改行 1 后，外部改行 5，再 commit',
      expected: '磁盘 = 行 1 事务值 + 行 5 外部值；回执 merges[].merged=true',
      async run(t) {
        const orig = Buffer.from('M1\nM2\nM3\nM4\nM5\n', 'utf8');
        t.write('t.txt', orig);
        await t.cliOk(['read', '--file', 't.txt', '--mode', 'full']);
        const b = await t.cliOk(['tx', 'begin']);
        const id = beginId(b);
        await t.cliOk(['edit', '--file', 't.txt', '--lines', '1', '--replace', 'M1-tx', '--tx', id]);
        const external = replaceLineBuffer(t.read('t.txt'), 5, 'M5-ext');
        t.write('t.txt', external);
        const r = await t.cliOk(['tx', 'commit', '--id', id]);
        t.eq('merges[0].merged=true', true, r.json?.merges?.[0]?.merged);
        const expected = replaceLineBuffer(external, 1, 'M1-tx');
        t.eqBytes('both changes present (merged bytes = oracle)', expected, t.read('t.txt'));
      },
    },
    {
      id: 'tx/external-overlap-conflict',
      purpose: '同一区域被外部改动：TX_CONFLICT，且 commit 一个字节都不写（磁盘 = 外部版本）',
      input: 'tx 改行 2 后，外部也改行 2，再 commit',
      expected: 'exit=2；code=TX_CONFLICT；磁盘 = 外部版本',
      async run(t) {
        const orig = Buffer.from('C1\nC2\nC3\n', 'utf8');
        t.write('t.txt', orig);
        await t.cliOk(['read', '--file', 't.txt', '--mode', 'full']);
        const b = await t.cliOk(['tx', 'begin']);
        const id = beginId(b);
        await t.cliOk(['edit', '--file', 't.txt', '--lines', '2', '--replace', 'C2-tx', '--tx', id]);
        const external = Buffer.from('C1\nC2-ext\nC3\n', 'utf8');
        t.write('t.txt', external);
        const r = await t.cli(['tx', 'commit', '--id', id]);
        t.eq('exit=2', 2, r.code);
        t.eq('code=TX_CONFLICT', 'TX_CONFLICT', r.json?.code);
        t.check('conflicts reported', (r.json?.conflicts?.length ?? 0) >= 1, {
          expected: '>=1 conflict',
          actual: r.json?.conflicts?.length ?? 0,
        });
        t.eqBytes('disk = external version (aura wrote nothing)', external, t.read('t.txt'));
      },
    },
    {
      id: 'tx/status-unknown-id',
      purpose: '查询不存在的事务 id：结构化拒绝而不是崩溃/栈',
      input: 'tx status --id does-not-exist',
      expected: 'ok=false；有 code；stdout 可 JSON 解析；无 Node 栈',
      async run(t) {
        t.write('f.txt', Buffer.from('x\n', 'utf8'));
        const r = await t.cli(['tx', 'status', '--id', 'tx-does-not-exist']);
        t.eq('not parsed as JSON failure', false, r.parseFailed);
        t.eq('ok=false', false, r.json?.ok);
        t.check('structured code present', typeof r.json?.code === 'string' && r.json.code.length > 0, {
          expected: 'code string',
          actual: r.json?.code ?? null,
        });
        t.check('no stack trace on stdout/stderr', !/\n\s+at\s/.test(r.stdout + r.stderr), {
          expected: 'no stack frames',
          actual: (r.stdout + r.stderr).slice(0, 200),
        });
      },
    },
    {
      id: 'tx/commit-unknown-id',
      purpose: '提交不存在的事务 id：结构化拒绝，不写盘',
      input: 'tx commit --id does-not-exist',
      expected: 'ok=false；有 code；磁盘不变',
      async run(t) {
        const orig = Buffer.from('x\n', 'utf8');
        t.write('f.txt', orig);
        const r = await t.cli(['tx', 'commit', '--id', 'tx-does-not-exist']);
        t.eq('ok=false', false, r.json?.ok);
        t.check('structured code present', typeof r.json?.code === 'string' && r.json.code.length > 0, {
          expected: 'code string',
          actual: r.json?.code ?? null,
        });
        t.eqBytes('disk unchanged', orig, t.read('f.txt'));
      },
    },
  ],
};
