import test from 'node:test';
import assert from 'node:assert/strict';

import { applyVersionRules, resolveVersion, supportedVersions } from '../src/lib/versions.mjs';

test('resolveVersion detects versions from questions', () => {
  assert.equal(resolveVersion('Node.js 20 的 fs.readFile 怎么用？', { id: 'node' }).version, '20');
  assert.equal(resolveVersion('Python 3.11 的 asyncio 怎么用？', { id: 'python' }).version, '3.11');
  assert.equal(resolveVersion('PostgreSQL 16 怎么创建表？', { id: 'postgres' }).version, '16');
  assert.equal(resolveVersion('MySQL 8.0 的事务隔离级别？', { id: 'mysql' }).version, '8.0');
  assert.equal(resolveVersion('Node.js fs 怎么读文件？', { id: 'node' }), null);
  assert.equal(resolveVersion('SearXNG 429 冷却时间', { id: 'searxng' }), null);
  assert.equal(resolveVersion('Node.js 99 的 fs', { id: 'node' }).supported, false);
  assert.equal(resolveVersion('Node.js fs', { id: 'node' }, '20').version, '20');
});

test('supportedVersions lists the allowed versions', () => {
  assert.ok(supportedVersions('node').includes('20'));
  assert.ok(supportedVersions('python').includes('3.11'));
  assert.deepEqual(supportedVersions('unknown'), []);
});

test('applyVersionRules rewrites deep source URLs and preserves paths', () => {
  const node = applyVersionRules([
    { url: 'https://nodejs.org/api/fs.html', title: 'fs' },
    { url: 'https://nodejs.org/api/http.html', title: 'http' },
  ], resolveVersion('Node.js 20 fs', { id: 'node' }));
  assert.equal(node[0].url, 'https://nodejs.org/docs/latest-v20.x/api/fs.html');
  assert.equal(node[1].url, 'https://nodejs.org/docs/latest-v20.x/api/http.html');
  assert.equal(node[0].version, '20');

  const python = applyVersionRules(
    [{ url: 'https://docs.python.org/3/library/asyncio.html' }],
    resolveVersion('Python 3.11 asyncio', { id: 'python' }),
  );
  assert.equal(python[0].url, 'https://docs.python.org/3.11/library/asyncio.html');

  const postgres = applyVersionRules(
    [{ url: 'https://www.postgresql.org/docs/current/sql-createtable.html' }],
    resolveVersion('PostgreSQL 16 create table', { id: 'postgres' }),
  );
  assert.equal(postgres[0].url, 'https://www.postgresql.org/docs/16/sql-createtable.html');

  const mysql = applyVersionRules(
    [{ url: 'https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html' }],
    resolveVersion('MySQL 8.0 isolation', { id: 'mysql' }),
  );
  assert.equal(mysql[0].url, 'https://dev.mysql.com/doc/refman/8.0/en/innodb-transaction-isolation-levels.html');
});

test('unsupported versions leave sources unchanged', () => {
  const resolved = resolveVersion('Node.js 99 fs', { id: 'node' });
  const sources = [{ url: 'https://nodejs.org/api/fs.html' }];
  assert.equal(resolved.supported, false);
  assert.deepEqual(applyVersionRules(sources, resolved), sources);
});
