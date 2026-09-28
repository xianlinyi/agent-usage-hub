import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageServer } from '../src/server/http.js';

test('push is idempotent and extensions can filter, group, and sum', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-hub-test-'));
  const { server, db } = createUsageServer({
    database: path.join(directory, 'usage.sqlite'), pushToken: 'push-test-token', adminToken: 'admin-test-token',
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (endpoint, auth = 'admin-test-token') => {
    const response = await fetch(base + endpoint, { headers: { authorization: `Bearer ${auth}` } });
    return { status: response.status, body: await response.json() };
  };
  const push = async events => {
    const response = await fetch(base + '/api/v1/events', {
      method: 'POST', headers: { authorization: 'Bearer push-test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ collectorId: 'laptop', events }),
    });
    return { status: response.status, body: await response.json() };
  };
  const snapshot = async (period, events) => {
    const response = await fetch(base + '/api/v1/snapshots', {
      method: 'POST', headers: { authorization: 'Bearer push-test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ collectorId: 'laptop', source: 'custom', period, events }),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await get('/api/v1/summary', 'bad')).status, 401);
  const first = {
    eventId: 'req-1', source: 'custom', agent: 'my-agent', model: 'test-model',
    occurredAt: '2026-09-01T12:00:00.000Z', inputTokens: 10, outputTokens: 5,
    cacheReadTokens: 2, extensions: { team: 'design', latency_ms: 125, active: true },
  };
  assert.deepEqual((await push([first])).body, { inserted: 1, updated: 0, unchanged: 0 });
  assert.deepEqual((await push([first])).body, { inserted: 0, updated: 0, unchanged: 1 });
  assert.deepEqual((await push([{ ...first, outputTokens: 7 }])).body, { inserted: 0, updated: 1, unchanged: 0 });
  const second = { ...first, eventId: 'req-2', occurredAt: '2026-09-02T10:00:00.000Z', extensions: { team: 'ops', latency_ms: 75, active: false } };
  assert.deepEqual((await push([second])).body, { inserted: 1, updated: 0, unchanged: 0 });
  const summary = await get('/api/v1/summary?from=2026-09-01&to=2026-09-01');
  assert.equal(summary.body.events, 1);
  assert.equal(summary.body.totalTokens, 19);
  const byTeam = await get('/api/v1/stats?groupBy=ext.team&metric=totalTokens');
  assert.deepEqual(byTeam.body.rows.map(row => [row.label, row.value]), [['design', 19], ['ops', 17]]);
  const latencies = await get('/api/v1/stats?groupBy=agent&metric=ext.latency_ms');
  assert.equal(latencies.body.rows[0].value, 200);
  const filtered = await get('/api/v1/events?filter.ext.team=design');
  assert.equal(filtered.body.rows.length, 1);
  const booleanFilter = await get('/api/v1/events?filter.ext.active=true');
  assert.equal(booleanFilter.body.rows.length, 1);
  const search = await get('/api/v1/events?q=design');
  assert.equal(search.body.rows.length, 1);
  const fields = await get('/api/v1/fields');
  assert.ok(fields.body.dimensions.includes('ext.team'));
  assert.ok(fields.body.metrics.includes('ext.latency_ms'));
  const invalid = await get('/api/v1/stats?groupBy=ext.team&metric=ext.team');
  assert.equal(invalid.status, 400);
  const third = { ...first, eventId: 'req-3', occurredAt: '2026-09-03T10:00:00.000Z' };
  const fourth = { ...third, eventId: 'req-4' };
  assert.deepEqual((await snapshot('2026-09-03', [third, fourth])).body, { inserted: 2, updated: 0, unchanged: 0, deleted: 0 });
  assert.deepEqual((await snapshot('2026-09-03', [third])).body, { inserted: 0, updated: 0, unchanged: 1, deleted: 1 });
  assert.equal((await get('/api/v1/summary')).body.events, 3);
  assert.deepEqual((await snapshot('2026-09-03', [])).body, { inserted: 0, updated: 0, unchanged: 0, deleted: 1 });
  assert.equal((await get('/api/v1/summary')).body.events, 2);
  assert.equal((await snapshot('2026-09-03', [first])).status, 400);
  assert.equal((await snapshot('2026-02-30', [])).status, 400);
  assert.equal((await snapshot('2026-09-03', [third, third])).status, 400);
});
