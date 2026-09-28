import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { builtinSources, collectSourceFile, sourceFiles } from '../src/collector/sources.js';
import { normalizeEvent } from '../src/records.js';

const time = '2026-09-28T10:00:00Z';
const jsonl = value => `${JSON.stringify(value)}\n`;

test('all built-in sources parse representative local usage data without ccusage', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-native-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixtures = {
    amp: ['threads/T-a.json', { id: 'thread', messages: [
      { role: 'user', messageId: 0, usage: { inputTokens: 99, outputTokens: 99 } },
      { role: 'assistant', messageId: 1,
        usage: { model: 'amp-model', timestamp: time, inputTokens: 4, outputTokens: 2 } }] }],
    droid: ['sessions/a.settings.json', { model: 'droid-model', providerLockTimestamp: time,
      tokenUsage: { inputTokens: 5, outputTokens: 2, thinkingTokens: 3, totalTokens: 10 } }],
    codebuff: ['projects/p/chats/c/chat-messages.json', [{ variant: 'ai', timestamp: time,
      metadata: { model: 'codebuff-model', usage: { inputTokens: 6, outputTokens: 2 } } }]],
    opencode: ['storage/message/s/a.json', { id: 'a', sessionID: 's', modelID: 'open-model', time: { created: time },
      tokens: { input: 7, output: 2 } }],
    gemini: ['tmp/p/other/a.json', { sessionId: 'a', model: 'gemini-model', messages: [
      { type: 'user', id: 'u', timestamp: time, tokens: { input: 99, output: 99 } },
      { type: 'gemini', id: 'm', timestamp: time, tokens: { input: 8, output: 2, thoughts: 4, total: 14 } }] }],
    grok: ['sessions/p/s/updates.jsonl', { timestamp: time, params: { sessionId: 's',
      update: { sessionUpdate: 'turn_completed', usage: { modelUsage: {
        'grok-model': { inputTokens: 9, outputTokens: 2, cachedReadTokens: 3 },
      } } }, _meta: { eventId: 'e' } } }],
    kimi: ['sessions/p/s/wire.jsonl', { type: 'usage.record', usageScope: 'turn', time: Date.parse(time),
      model: 'kimi-model', usage: { inputOther: 10, output: 2 } }],
    qwen: ['chats/a.jsonl', { type: 'assistant', id: 'a', timestamp: time, model: 'qwen-model',
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 2,
        thoughtsTokenCount: 3, totalTokenCount: 16 } }],
    pi: ['sessions/p/a.jsonl', { type: 'message', timestamp: time,
      message: { role: 'assistant', model: 'pi-model', usage: { input: 12, output: 2 } } }],
    openclaw: ['agents/main/sessions/a.jsonl', { type: 'message', id: 'e', timestamp: time,
      message: { role: 'assistant', model: 'claw-model', usage: { input: 13, output: 2 } } }],
    copilot: ['session-state/a/events.jsonl', { type: 'session.shutdown', id: 'e', timestamp: time,
      data: { modelMetrics: { 'copilot-model': { usage: { inputTokens: 14, outputTokens: 2 } } } } }],
  };
  const results = new Map();
  for (const [source, [relative, content]] of Object.entries(fixtures)) {
    const filename = path.join(directory, source, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, filename.endsWith('.jsonl') ? jsonl(content) : JSON.stringify(content));
    const found = [];
    for await (const item of sourceFiles(source, { [source]: path.join(directory, source) })) found.push(item.filename);
    assert.ok(found.includes(filename), `${source} discovery`);
    const events = [];
    for await (const item of collectSourceFile(source, filename)) events.push(normalizeEvent(item, 'fixture'));
    assert.equal(events.length, 1, `${source} parsed one usage event`);
    assert.ok(events[0].totalTokens > 0, `${source} token total`);
    results.set(source, events[0]);
  }
  for (const [source, expected] of [['droid', 3], ['gemini', 4], ['qwen', 3]]) {
    assert.equal(results.get(source).reasoningTokens, expected, `${source} reasoning subset`);
    assert.equal(results.get(source).otherTokens, 0, `${source} does not classify reasoning as other`);
  }

  const sqlite = [
    ['goose', 'sessions/sessions.db', db => {
      db.exec('CREATE TABLE sessions(id TEXT,model_config_json TEXT,provider_name TEXT,created_at TEXT,total_tokens INTEGER,input_tokens INTEGER,output_tokens INTEGER,accumulated_total_tokens INTEGER,accumulated_input_tokens INTEGER,accumulated_output_tokens INTEGER)');
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?)').run('s', '{"model_name":"goose-model"}', 'test', time, 17, 15, 2, null, null, null);
    }],
    ['hermes', 'state.db', db => {
      db.exec('CREATE TABLE sessions(id TEXT,model TEXT,started_at REAL,input_tokens INTEGER,output_tokens INTEGER)');
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run('s', 'hermes-model', Date.parse(time) / 1000, 16, 2);
    }],
    ['kilo', 'kilo.db', db => {
      db.exec('CREATE TABLE message(id TEXT,session_id TEXT,data TEXT)');
      db.prepare('INSERT INTO message VALUES(?,?,?)').run('m', 's', JSON.stringify({ role: 'assistant', modelID: 'kilo-model', time: { created: Date.parse(time) }, tokens: { input: 17, output: 2 } }));
    }],
    ['opencode', 'opencode.db', db => {
      db.exec('CREATE TABLE message(id TEXT,session_id TEXT,data TEXT)');
      db.prepare('INSERT INTO message VALUES(?,?,?)').run('m', 's', JSON.stringify({ modelID: 'open-model', time: { created: Date.parse(time) }, tokens: { input: 18, output: 2 } }));
    }],
    ['zcode', 'cli/db/db.sqlite', db => {
      db.exec('CREATE TABLE model_usage(id TEXT,session_id TEXT,started_at INTEGER,model_id TEXT,status TEXT,input_tokens INTEGER,output_tokens INTEGER)');
      db.prepare('INSERT INTO model_usage VALUES(?,?,?,?,?,?,?)').run('m', 's', Date.parse(time), 'zcode-model', 'completed', 19, 2);
    }],
    ['openclaw', 'agents/main/agent/openclaw-agent.sqlite', db => {
      db.exec('CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,created_at INTEGER)');
      db.prepare('INSERT INTO transcript_events VALUES(?,?,?,?)').run('s', 1,
        JSON.stringify({ type: 'message', id: 'm', message: { role: 'assistant', model: 'claw-model', usage: { input: 20, output: 2 } } }), Date.parse(time));
    }],
  ];
  for (const [source, relative, setup] of sqlite) {
    const filename = path.join(directory, source, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    const db = new DatabaseSync(filename);
    setup(db);
    db.close();
    const found = [];
    for await (const item of sourceFiles(source, { [source]: path.join(directory, source) })) found.push(item.filename);
    assert.ok(found.includes(filename), `${source} SQLite discovery`);
    const events = [];
    for await (const item of collectSourceFile(source, filename)) events.push(normalizeEvent(item, 'fixture'));
    assert.equal(events.length, 1, `${source} SQLite parsed`);
    results.set(source, events[0]);
  }
  assert.deepEqual(new Set(builtinSources).difference(new Set([...results.keys(), 'codex', 'claude', 'antigravity'])), new Set());
});

test('Copilot shutdown snapshots use interval deltas', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-copilot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'events.jsonl');
  const row = (id, count) => ({ type: 'session.shutdown', id, timestamp: time,
    data: { modelMetrics: { model: { usage: { inputTokens: count, outputTokens: 2 } } } } });
  await writeFile(filename, `${jsonl(row('a', 10))}${jsonl(row('b', 15))}`);
  const events = [];
  for await (const item of collectSourceFile('copilot', filename)) events.push(item);
  assert.equal(events.reduce((sum, item) => sum + item.inputTokens, 0), 15);
});

test('Antigravity decodes token counters from SQLite protobuf blobs', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-antigravity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'conversations', 'session.db');
  await mkdir(path.dirname(filename), { recursive: true });
  const varint = value => {
    const bytes = [];
    let remaining = value;
    while (remaining >= 128) { bytes.push((remaining & 127) | 128); remaining >>= 7; }
    bytes.push(remaining);
    return Buffer.from(bytes);
  };
  const scalar = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
  const bytes = (field, value) => Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
  const usageBlob = Buffer.concat([scalar(2, 21), scalar(3, 4), scalar(5, 3), bytes(11, Buffer.from('response-a'))]);
  const chat = Buffer.concat([bytes(4, usageBlob), bytes(19, Buffer.from('gemini-test'))]);
  const db = new DatabaseSync(filename);
  db.exec('CREATE TABLE gen_metadata(idx INTEGER,data BLOB)');
  db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(1, bytes(1, chat));
  db.close();
  const events = [];
  for await (const item of collectSourceFile('antigravity', filename)) events.push(normalizeEvent(item, 'fixture'));
  assert.equal(events.length, 1);
  assert.equal(events[0].totalTokens, 28);
  assert.equal(events[0].model, 'gemini-test');
});

test('OpenCode v2 fork excludes copied parent message rows', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-opencode-fork-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'opencode.db');
  const db = new DatabaseSync(filename);
  db.exec('CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,data TEXT)');
  db.exec('CREATE TABLE session_v2(id TEXT,fork_session_id TEXT,fork_boundary TEXT)');
  const put = (id, session, seq, input) => db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?)').run(id, session,
    'assistant', seq, JSON.stringify({ modelID: 'open-model', time: { created: Date.parse(time) },
      tokens: { input, output: 2 } }));
  put('parent-a', 'parent', 1, 10);
  put('copy-a', 'child', 1, 10);
  put('child-own', 'child', 2, 30);
  db.prepare('INSERT INTO session_v2 VALUES(?,?,?)').run('child', 'parent', JSON.stringify({ type: 'through', messageID: 'parent-a' }));
  db.close();
  const events = [];
  for await (const item of collectSourceFile('opencode', filename)) events.push(item);
  assert.equal(events.length, 2);
  assert.equal(events.reduce((sum, item) => sum + item.inputTokens, 0), 40);
});
