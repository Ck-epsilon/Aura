import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { fetchDocument, fetchRaw } from '../src/lib/fetch.mjs';
import { CODES } from '../src/lib/errors.mjs';

const PRIVATE_TARGETS = [
  'http://127.0.0.1:1/',
  'http://localhost:1/',
  'http://0.0.0.0/',
  'http://10.0.0.1/',
  'http://172.16.0.1/',
  'http://192.168.0.1/',
  'http://169.254.169.254/latest/meta-data',
  'http://[::1]:1/',
  'http://[::ffff:7f00:1]/',
];

for (const target of PRIVATE_TARGETS) {
  test(`blocks private target ${target}`, async () => {
    await assert.rejects(fetchRaw(target, { retries: 0 }), (error) => error.code === CODES.PRIVATE_ADDRESS);
  });
}

test('allowPrivate opt-in fetches loopback', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Local Doc</title></head><body><p>local only</p></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const doc = await fetchDocument(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    assert.equal(doc.title, 'Local Doc');
    assert.match(doc.text, /local only/);
  } finally {
    server.close();
  }
});

test('redirects are followed and re-validated when private access is allowed', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/page' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<title>Redirected</title><p>ok</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const page = await fetchRaw(`http://127.0.0.1:${port}/redirect`, { allowPrivate: true });
    assert.equal(page.status, 200);
    assert.match(page.finalUrl, /\/page$/);
  } finally {
    server.close();
  }
});
