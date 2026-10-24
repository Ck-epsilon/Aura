import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('canonical aura_argus CLI commands are accepted', () => {
  const version = run(['aura_argus_version']);
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);
  assert.equal(run(['version']).stdout, version.stdout);

  const help = run(['aura_argus_help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /aura_argus_search/);
  assert.match(help.stdout, /aura_argus_mcp/);
});
test('legacy search/fetch commands are removed', () => {
  const legacy = run(['search', 'anything']);
  assert.notEqual(legacy.status, 0);
  assert.doesNotMatch(legacy.stdout, /Legacy aliases/);
});
