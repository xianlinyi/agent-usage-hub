import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageServer } from '../src/server/http.js';
import { collectOnce } from '../src/collector/index.js';

test('native collector reads a local agent log and updates stable usage records', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-collector-test-'));
  const { server, db } = createUsageServer({ database: path.join(directory, 'db.sqlite'), pushToken: 'push-test', adminToken: 'admin-test' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const tokenFile = path.join(directory, 'push-token');
  await writeFile(tokenFile, 'push-test\n');
  const config = {
    serverUrl: `http://127.0.0.1:${server.address().port}`, collectorId: 'test-device',
    tokenFile, stateFile: path.join(directory, 'state.json'), sources: ['qwen'],
    paths: { qwen: path.join(directory, 'qwen') }, extensions: { team: 'test' },
  };
  const sourceFile = path.join(directory, 'qwen', 'chats', 'session.jsonl');
  await mkdir(path.dirname(sourceFile), { recursive: true });
  const row = input => ({ type: 'assistant', id: 'turn-1', timestamp: '2026-09-28T10:00:00Z', model: 'qwen-test',
    usageMetadata: { promptTokenCount: input, candidatesTokenCount: 3, cachedContentTokenCount: 2,
      totalTokenCount: input + 5 } });
  await writeFile(sourceFile, `${JSON.stringify(row(10))}\n`);
  const first = await collectOnce(config);
  assert.equal(first.inserted, 1);
  const same = await collectOnce(config);
  assert.equal(same.skippedFiles, 1);
  await writeFile(sourceFile, `${JSON.stringify(row(14))}\n`);
  const second = await collectOnce(config);
  assert.equal(second.updated, 1);
  assert.equal(db.summary(new URLSearchParams()).totalTokens, 19);
  assert.equal(db.events(new URLSearchParams('filter.ext.team=test'))[0].source, 'qwen');
  await writeFile(sourceFile, '');
  const cleared = await collectOnce(config);
  assert.equal(cleared.deleted, 1);
  assert.equal(db.summary(new URLSearchParams()).events, 0);
  await writeFile(sourceFile, `${JSON.stringify(row(10))}\n`);
  await collectOnce(config);
  await rm(sourceFile);
  const removed = await collectOnce(config);
  assert.equal(removed.deleted, 1);
  assert.equal(db.summary(new URLSearchParams()).events, 0);
});

test('custom application plugin pushes searchable numeric extensions', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-plugin-test-'));
  const { server, db } = createUsageServer({ database: path.join(directory, 'db.sqlite'), pushToken: 'push-test', adminToken: 'admin-test' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const tokenFile = path.join(directory, 'push-token');
  const sourceFile = path.join(directory, 'usage.jsonl');
  await writeFile(tokenFile, 'push-test\n');
  await writeFile(sourceFile, `${JSON.stringify({ id: '1', agent: 'editor', model: 'm1', timestamp: '2026-09-28T12:00:00Z',
    inputTokens: 10, outputTokens: 5, team: 'research', latencyMs: 123 })}\n`);
  const result = await collectOnce({
    serverUrl: `http://127.0.0.1:${server.address().port}`, collectorId: 'plugin-device',
    tokenFile, stateFile: path.join(directory, 'state.json'), sources: [],
    extensions: { environment: 'test' },
    plugins: [{ path: path.resolve('examples/custom-collector.mjs'), config: { file: sourceFile } }],
  });
  assert.equal(result.inserted, 1);
  assert.equal(db.stats(new URLSearchParams('groupBy=ext.team&metric=ext.latency_ms'))[0].value, 123);
  assert.equal(db.events(new URLSearchParams('filter.ext.environment=test'))[0].agent, 'editor');
});
