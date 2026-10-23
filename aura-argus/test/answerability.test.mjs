import test from 'node:test';
import assert from 'node:assert/strict';

import { isAnswerable } from '../src/lib/answerability.mjs';

const evidence = (text) => [{ passages: [{ text }] }];

test('error answers require the error marker and an actionable hint in one passage', () => {
  assert.equal(isAnswerable({
    question: 'Redis 报错 OOM command not allowed 怎么解决？',
    intent: 'error',
    evidence: evidence('the command flags include write and denyoom'),
    terms: ['redis', 'oom'],
  }), false);
  assert.equal(isAnswerable({
    question: 'Redis 报错 OOM command not allowed 怎么解决？',
    intent: 'error',
    evidence: evidence('set maxmemory-policy noeviction to avoid OOM errors'),
    terms: ['redis', 'oom'],
  }), true);
});

test('comparison answers require both sides and numeric port context', () => {
  assert.equal(isAnswerable({
    question: 'PostgreSQL 和 MySQL 的默认端口分别是多少？',
    intent: 'compare',
    evidence: evidence('PostgreSQL and MySQL are relational databases.'),
    terms: ['postgresql', 'mysql', 'port'],
  }), false);
  assert.equal(isAnswerable({
    question: 'PostgreSQL 和 MySQL 的默认端口分别是多少？',
    intent: 'compare',
    evidence: evidence('PostgreSQL uses port 5432 and MySQL uses port 3306.'),
    terms: ['postgresql', 'mysql', 'port'],
  }), true);
});

test('comparison answers require both named sides', () => {
  assert.equal(isAnswerable({
    question: 'Nginx 和 Apache 有什么区别？',
    intent: 'compare',
    evidence: evidence('Nginx is an asynchronous web server and reverse proxy.'),
    terms: ['nginx', 'apache', 'difference'],
  }), false);
  assert.equal(isAnswerable({
    question: 'Nginx 和 Apache 有什么区别？',
    intent: 'compare',
    evidence: evidence('Nginx and Apache differ in process and connection handling.'),
    terms: ['nginx', 'apache', 'difference'],
  }), true);
});

test('non-error/non-compare intents keep facet-based behavior', () => {
  assert.equal(isAnswerable({
    question: 'React 的 useState 怎么用？',
    intent: 'howto',
    evidence: evidence('useState returns a state value and a setter hook.'),
    terms: ['react', 'usestate'],
  }), true);
  assert.equal(isAnswerable({
    question: 'Redis 默认端口是多少？',
    intent: 'fact',
    evidence: evidence('Redis default port is 6379.'),
    terms: ['redis', 'port'],
  }), true);
});
