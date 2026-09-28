import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectCodexFile } from '../src/collector/adapters/codex.js';
import { collectClaudeFile } from '../src/collector/adapters/claude.js';

test('native Codex parser ignores repeated cumulative token snapshots', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-adapter-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'codex.jsonl');
  const line = (type, payload, second) => JSON.stringify({ timestamp: `2026-09-01T00:00:0${second}Z`, type, payload });
  await writeFile(filename, [
    line('session_meta', { id: 'session-1', cwd: '/workspace/project' }, 0),
    line('turn_context', { model: 'model-x' }, 1),
    line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 } } }, 2),
    line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 5 } } }, 3),
    line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 120, cached_input_tokens: 25, output_tokens: 40, reasoning_output_tokens: 8 } } }, 4),
  ].join('\n'));
  const events = [];
  for await (const event of collectCodexFile(filename)) events.push(event);
  assert.equal(events.length, 2);
  assert.equal(events.reduce((sum, event) => sum + event.inputTokens + event.cacheReadTokens + event.outputTokens, 0), 160);
});

test('Codex subagent replay before its turn is excluded', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-codex-fork-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'fork.jsonl');
  const row = (type, payload, second) => ({ type, payload, timestamp: `2026-09-01T00:00:0${second}Z` });
  const token = (input, output, second) => row('event_msg', { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, output_tokens: output },
  } }, second);
  await writeFile(filename, [
    row('session_meta', { id: 'child', forked_from_id: 'parent' }, 0),
    token(100, 20, 1),
    row('event_msg', { type: 'task_started' }, 2),
    token(130, 25, 3),
  ].map(JSON.stringify).join('\n'));
  const events = [];
  for await (const item of collectCodexFile(filename)) events.push(item);
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens + events[0].outputTokens, 35);
});

test('Codex resumed log uses last-turn usage when cumulative totals start above zero', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-codex-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'resume.jsonl');
  await writeFile(filename, `${JSON.stringify({ type: 'event_msg', timestamp: '2026-09-27T10:00:00Z',
    payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 },
      last_token_usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 10 },
    } } })}\n`);
  const events = [];
  for await (const item of collectCodexFile(filename)) events.push(item);
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens + events[0].cacheReadTokens + events[0].outputTokens, 60);
});

test('native Claude parser keeps the final usage snapshot for a request', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-claude-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'claude.jsonl');
  const row = output => ({ type: 'assistant', timestamp: '2026-09-01T00:00:00Z', requestId: 'req-1', sessionId: 's-1',
    message: { id: 'msg-1', model: 'claude-test', usage: { input_tokens: 2, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 } } });
  await writeFile(filename, `${JSON.stringify(row(2))}\n${JSON.stringify(row(20))}\n`);
  const events = [];
  for await (const event of collectClaudeFile(filename)) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].outputTokens, 20);
});

test('Claude counts advisor iterations and drops a sidechain replay of the parent', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-claude-advisor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'claude.jsonl');
  const parent = { type: 'assistant', timestamp: '2026-09-01T00:00:00Z', sessionId: 's',
    requestId: 'original', message: { id: 'same-message', model: 'main-model', usage: {
      input_tokens: 2, output_tokens: 3, iterations: [{ type: 'advisor_message', model: 'advisor-model',
        input_tokens: 4, output_tokens: 5 }],
    } } };
  await writeFile(filename, `${JSON.stringify({ ...parent, isSidechain: true, requestId: 'replay' })}\n${JSON.stringify(parent)}\n`);
  const events = [];
  for await (const item of collectClaudeFile(filename)) events.push(item);
  assert.equal(events.length, 2);
  assert.deepEqual(new Set(events.map(item => item.model)), new Set(['main-model', 'advisor-model']));
});
