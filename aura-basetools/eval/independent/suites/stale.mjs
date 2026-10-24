// Staleness / read-before-write safety. The point of every negative case is not only the
// refusal code but that the bytes on disk are exactly the external version afterwards.

import { replaceLineBuffer } from '../lib/harness.mjs';

const L8 = Buffer.from('l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n', 'utf8');

export const suite = {
  id: 'stale',
  title: '陈旧安全（读后外部改：区域级拒绝 / 非重叠放行 / 严格新鲜度 / 预演同样判决）',
  cases: [
    {
      id: 'stale/region-changed-refused',
      purpose: '读后被外部改了**被寻址区域**：无 expect 的编辑必须拒绝，且磁盘字节 = 外部版本（不能半写）',
      input: '读全文件 → 外部把第 3 行改成 CHANGED → edit lines=3',
      expected: 'exit=2；code=PATCH_STALE_REGION；磁盘 = 外部版本',
      async run(t) {
        t.write('f.txt', L8);
        await t.cliOk(['read', '--file', 'f.txt', '--mode', 'full']);
        const external = Buffer.from('l1\nl2\nCHANGED\nl4\nl5\nl6\nl7\nl8\n', 'utf8');
        t.write('f.txt', external);
        const r = await t.cli(['edit', '--file', 'f.txt', '--lines', '3', '--replace', 'X3']);
        t.eq('exit=2', 2, r.code);
        t.eq('code=PATCH_STALE_REGION', 'PATCH_STALE_REGION', r.json?.code);
        t.eqBytes('disk bytes = external version (nothing written)', external, t.read('f.txt'));
      },
    },
    {
      id: 'stale/old-fragment-still-matches',
      purpose: 'old 片段地址的边界：外部改了同一行但片段仍在时按片段命中继续编辑（不做区域拒绝），但必须标 unverified_region 且保留片段之外的字节',
      input: '读 "q1\\nq2\\nq3\\n" → 外部改为 "q1\\nq2-EXTERNAL\\nq3\\n" → edit --old q2',
      expected: '成功；磁盘 = "q1\\nQ2-EXTERNAL\\nq3\\n"；回执 after 与 unverified_region=true',
      async run(t) {
        t.write('f.txt', Buffer.from('q1\nq2\nq3\n', 'utf8'));
        await t.cliOk(['read', '--file', 'f.txt', '--mode', 'full']);
        t.write('f.txt', Buffer.from('q1\nq2-EXTERNAL\nq3\n', 'utf8'));
        const r = await t.cliOk(['edit', '--file', 'f.txt', '--old', 'q2', '--replace', 'Q2']);
        t.eqBytes('only the fragment changed, external text kept', Buffer.from('q1\nQ2-EXTERNAL\nq3\n', 'utf8'), t.read('f.txt'));
        t.eq('receipt after = whole line after the fragment edit', 'Q2-EXTERNAL', r.json?.result?.applied?.[0]?.after);
        t.eq('receipt unverified_region=true (disclosed)', true, r.json?.result?.unverified_region);
      },
    },
    {
      id: 'stale/non-addressed-change-allowed',
      purpose: '读后外部改的是**别的行**：不应误拒；本次编辑只落在自己的行上，外部改动保留',
      input: '读全文件 → 外部把第 7 行改成 l7EXT → edit lines=5',
      expected: '成功；磁盘 = 外部版本 + 第 5 行改为 X5',
      async run(t) {
        t.write('f.txt', L8);
        await t.cliOk(['read', '--file', 'f.txt', '--mode', 'full']);
        const external = Buffer.from('l1\nl2\nl3\nl4\nl5\nl6\nl7EXT\nl8\n', 'utf8');
        t.write('f.txt', external);
        const r = await t.cliOk(['edit', '--file', 'f.txt', '--lines', '5', '--replace', 'X5']);
        t.eqBytes('external edit preserved + own edit applied', replaceLineBuffer(external, 5, 'X5'), t.read('f.txt'));
        t.eq('receipt marks unverified_region (region gate could not use a fresh read)', true, r.json?.result?.unverified_region === true);
      },
    },
    {
      id: 'stale/no-read-allowed-but-marked',
      purpose: '没有观测时默认放行（公开承诺），但回执必须如实标 unverified_region',
      input: '全新文件，未读，edit lines=2',
      expected: '成功；回执 unverified_region=true',
      async run(t) {
        const orig = Buffer.from('a\nb\nc\n', 'utf8');
        t.write('f.txt', orig);
        const r = await t.cliOk(['edit', '--file', 'f.txt', '--lines', '2', '--replace', 'B']);
        t.eq('receipt unverified_region=true', true, r.json?.result?.unverified_region);
        t.eqBytes('file matches oracle', replaceLineBuffer(orig, 2, 'B'), t.read('f.txt'));
      },
    },
    {
      id: 'stale/require-observation-refused',
      purpose: '--require-observation 严格闸：当前这版没读过 ⇒ PATCH_UNOBSERVED（reason=never-read），零写入',
      input: '全新文件，未读，edit --require-observation',
      expected: 'code=PATCH_UNOBSERVED；reason=never-read；磁盘不变',
      async run(t) {
        const orig = Buffer.from('a\nb\nc\n', 'utf8');
        t.write('f.txt', orig);
        const r = await t.cli(['edit', '--file', 'f.txt', '--lines', '2', '--replace', 'B', '--require-observation']);
        t.eq('code=PATCH_UNOBSERVED', 'PATCH_UNOBSERVED', r.json?.code);
        t.eq('reason=never-read', 'never-read', r.json?.reason);
        t.eqBytes('disk unchanged', orig, t.read('f.txt'));
      },
    },
    {
      id: 'stale/require-observation-after-read-ok',
      purpose: '严格闸的阳性对照：先读同一版后带 --require-observation 应成功',
      input: '读全文件 → edit lines=2 --require-observation',
      expected: '成功；磁盘 = oracle',
      async run(t) {
        const orig = Buffer.from('a\nb\nc\n', 'utf8');
        t.write('f.txt', orig);
        await t.cliOk(['read', '--file', 'f.txt', '--mode', 'full']);
        await t.cliOk(['edit', '--file', 'f.txt', '--lines', '2', '--replace', 'B', '--require-observation']);
        t.eqBytes('file matches oracle', replaceLineBuffer(orig, 2, 'B'), t.read('f.txt'));
      },
    },
    {
      id: 'stale/write-overwrite-never-read',
      purpose: '整份覆写默认要求先读过这一版：未读 ⇒ PATCH_UNOBSERVED（never-read），零写入',
      input: '全新文件，未读，write --content',
      expected: 'code=PATCH_UNOBSERVED；reason=never-read；磁盘不变',
      async run(t) {
        const orig = Buffer.from('original\n', 'utf8');
        t.write('f.txt', orig);
        const r = await t.cli(['write', '--file', 'f.txt', '--content', 'replacement\n']);
        t.eq('code=PATCH_UNOBSERVED', 'PATCH_UNOBSERVED', r.json?.code);
        t.eq('reason=never-read', 'never-read', r.json?.reason);
        t.eqBytes('disk unchanged', orig, t.read('f.txt'));
      },
    },
    {
      id: 'stale/write-changed-since-read',
      purpose: '读写之间外部改过：覆写必须拒绝 changed-since-read，磁盘 = 外部版本',
      input: '读 → 外部改 → write --content',
      expected: 'code=PATCH_UNOBSERVED；reason=changed-since-read；磁盘 = 外部版本',
      async run(t) {
        t.write('f.txt', Buffer.from('v1\n', 'utf8'));
        await t.cliOk(['read', '--file', 'f.txt', '--mode', 'full']);
        const external = Buffer.from('v1-external\n', 'utf8');
        t.write('f.txt', external);
        const r = await t.cli(['write', '--file', 'f.txt', '--content', 'v2\n']);
        t.eq('code=PATCH_UNOBSERVED', 'PATCH_UNOBSERVED', r.json?.code);
        t.eq('reason=changed-since-read', 'changed-since-read', r.json?.reason);
        t.eqBytes('disk = external version', external, t.read('f.txt'));
      },
    },
    {
      id: 'stale/allow-unobserved-write',
      purpose: '--allow-unobserved 是显式逃生门：允许盲写，回执照实标 unverified_region',
      input: '未读文件，write --allow-unobserved',
      expected: '成功；unverified_region=true；字节 = content',
      async run(t) {
        t.write('f.txt', Buffer.from('original\n', 'utf8'));
        const r = await t.cliOk(['write', '--file', 'f.txt', '--content', 'blind\n', '--allow-unobserved']);
        t.eq('receipt unverified_region=true', true, r.json?.result?.unverified_region);
        t.eqBytes('bytes = content', Buffer.from('blind\n', 'utf8'), t.read('f.txt'));
      },
    },
    {
      id: 'stale/dry-run-same-judgement',
      purpose: '预演不撒谎：陈旧区域上的 --dry-run 同样必须拒绝（不是「预演就放行」）',
      input: '读 → 外部改第 3 行 → edit lines=3 --dry-run',
      expected: 'code=PATCH_STALE_REGION；磁盘 = 外部版本',
      async run(t) {
        t.write('f.txt', L8);
        await t.cliOk(['read', '--file', 'f.txt', '--mode', 'full']);
        const external = Buffer.from('l1\nl2\nCHANGED\nl4\nl5\nl6\nl7\nl8\n', 'utf8');
        t.write('f.txt', external);
        const r = await t.cli(['edit', '--file', 'f.txt', '--lines', '3', '--replace', 'X', '--dry-run']);
        t.eq('code=PATCH_STALE_REGION', 'PATCH_STALE_REGION', r.json?.code);
        t.eqBytes('disk = external version', external, t.read('f.txt'));
      },
    },
  ],
};
