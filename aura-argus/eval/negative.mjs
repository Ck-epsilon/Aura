// 负例与边界：未知实体、别名匹配、CLI 退出码。
import { matchEntity } from '../src/lib/registry.mjs';
import { search } from '../src/lib/router.mjs';

const failures = [];
const ok = (name, cond, detail = '') => {
  if (!cond) failures.push(`${name}${detail ? ' — ' + detail : ''}`);
};

ok('unknown entity → null', matchEntity('量子计算机的退相干时间是多少？') === null);
ok('alias 深度求索 → deepseek', matchEntity('深度求索 的搜索 API 多少钱？')?.id === 'deepseek');
ok('alias SearXNG → searxng', matchEntity('SearXNG 429 冷却')?.id === 'searxng');
ok('google alias → google-cse', matchEntity('Google Custom Search 还能用吗')?.id === 'google-cse');

const unknown = await search('量子计算机的退相干时间是多少？', { cache: false, fallback: false });
ok('unknown retrieve → no evidence', unknown.entity === null && unknown.evidence.length === 0);
ok('unknown retrieve → attempts empty', unknown.attempts.length === 0);

const known = await search('Tavily 一个 credit 多少钱？', { cache: false });
ok('known entity → evidence', known.entity === 'tavily' && known.evidence.length > 0);
ok('known entity → passages', known.evidence.every((e) => e.passages.length > 0));

if (failures.length) {
  console.error('FAIL');
  for (const failure of failures) console.error(' -', failure);
  process.exit(2);
}
console.log('negative tests passed');
