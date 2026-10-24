// Random differential testing with a fixed seed. The generator and the oracle are both
// implemented here from plain strings/Buffers; the tool never supplies an expectation.

import { hex, inspectBuffer, replaceLineBuffer, spliceUniqueBytes } from '../lib/harness.mjs';

export const SEED = 20261024;
const CASE_COUNT = 80;

function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASCII = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.()[]{}=+:;!?';
const CJK = Array.from('的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想');
const EMOJI = ['🙂', '🚀', '✅', '🧪', '🔥', '🌍', '🎯', '🀄', '👨‍👩‍👧‍👦'];

function build(seed) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (n) => Math.floor(rnd() * n);

  const randomContent = (len) => {
    let s = '';
    for (let i = 0; i < len; i++) {
      const roll = rnd();
      if (roll < 0.58) s += ASCII[int(ASCII.length)];
      else if (roll < 0.9) s += CJK[int(CJK.length)];
      else s += EMOJI[int(EMOJI.length)];
    }
    return s;
  };

  const cases = [];
  for (let index = 0; index < CASE_COUNT; index++) {
    const mode = rnd() < 0.25 ? 'old' : 'lines';
    const style = pick(['lf', 'crlf', 'mixed']);
    const bom = rnd() < 0.35;
    const trailing = rnd() < 0.6;
    const lineCount = 3 + int(8);
    const targetLine = 1 + int(lineCount);

    const lines = [];
    for (let i = 0; i < lineCount; i++) lines.push(randomContent(1 + int(10)));

    const terminatorFor = () => (style === 'crlf' ? '\r\n' : style === 'lf' ? '\n' : pick(['\n', '\r\n']));

    const eols = [];
    for (let i = 0; i < lineCount; i++) eols.push(i === lineCount - 1 && !trailing ? '' : terminatorFor());

    let newText = randomContent(1 + int(8));
    let token = null;

    if (mode === 'old') {
      token = `Tkn${index}Z`;
      const line = lines[targetLine - 1];
      const atEnd = rnd() < 0.5;
      lines[targetLine - 1] = atEnd ? `${line}${token}` : `${token}${line}`;
      if (newText === token) newText = `${newText}!`;
    } else if (newText === lines[targetLine - 1]) {
      newText = `${newText}!`;
    }

    const body = lines.map((line, i) => line + eols[i]).join('');
    const buf = Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(body, 'utf8')]);

    const expected = mode === 'lines' ? replaceLineBuffer(buf, targetLine, newText) : spliceUniqueBytes(buf, token, newText);

    const inputSummary =
      `#${String(index).padStart(2, '0')} mode=${mode} bom=${bom ? 'yes' : 'no'} eol=${style} ` +
      `trailing=${trailing ? 'yes' : 'no'} lines=${lineCount} target=${targetLine}` +
      (token ? ` token=${token}` : '') +
      ` bytes=${hex(buf, 64)}`;

    const id = `fuzz/${String(index).padStart(3, '0')}-${mode}-${style}-${bom ? 'bom' : 'nobom'}-${trailing ? 'nl' : 'nonl'}`;

    cases.push({
      id,
      purpose: `随机差分 #${index}：独立 oracle 逐字节比较（${mode === 'lines' ? 'lines 整行替换' : 'old 唯一片段替换'}）`,
      input: inputSummary,
      expected: `hex=${hex(expected, 96)}`,
      data: { seed, index, mode, style, bom, trailing, lineCount, targetLine },
      async run(t) {
        t.write('f.txt', buf);
        if (mode === 'lines') {
          const r = await t.cli(['edit', '--file', 'f.txt', '--lines', String(targetLine), '--replace', newText]);
          t.eq('exit=0', 0, r.code);
          t.eq('ok=true', true, r.json?.ok);
          t.eq('receipt line = addressed line', targetLine, r.json?.result?.applied?.[0]?.line);
        } else {
          const r = await t.cli(['edit', '--file', 'f.txt', '--old', token, '--replace', newText]);
          t.eq('exit=0', 0, r.code);
          t.eq('ok=true', true, r.json?.ok);
        }
        t.eqBytes('bytes match independent oracle', expected, t.read('f.txt'));
        t.eq('BOM presence unchanged by the edit', inspectBuffer(buf).hasBom, inspectBuffer(t.read('f.txt')).hasBom);
      },
    });
  }
  return cases;
}

export const suite = {
  id: 'fuzz',
  title: `随机差分（seed=${SEED}，${CASE_COUNT} 组随机文本 × 随机单行编辑 × BOM/行尾/尾换行组合）`,
  cases: build(SEED),
};
