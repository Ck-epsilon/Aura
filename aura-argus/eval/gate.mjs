// 1.0 发布门：answerability 与尾延迟同时达标才通过。
import fs from 'node:fs';

const file = new URL('./answerability.json', import.meta.url);
if (!fs.existsSync(file)) {
  console.error('answerability.json missing; run `npm run eval` then `npm run answerability`');
  process.exit(2);
}
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const minRate = Number(process.env.AURA_ARGUS_MIN_ANSWERABILITY ?? 0.9);
const maxP95 = Number(process.env.AURA_ARGUS_MAX_P95_MS ?? 2500);
const failures = [];
if (report.rate < minRate) failures.push(`answerability ${report.rate} < ${minRate}`);
if (report.p95 > maxP95) failures.push(`p95 ${report.p95}ms > ${maxP95}ms`);
if (report.failures?.length) failures.push(`${report.failures.length} answerability failures`);
console.log(JSON.stringify({
  ok: failures.length === 0,
  rate: report.rate,
  minRate,
  p95: report.p95,
  maxP95,
  failures,
}, null, 2));
process.exitCode = failures.length ? 2 : 0;
