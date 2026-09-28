import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { date, event, first, integer, number, usage } from './native-common.js';

const parse = raw => { try { return JSON.parse(raw); } catch { return null; } };
const rows = (db, sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
const hasTable = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
const columns = (db, table) => new Set(rows(db, `PRAGMA table_info(${table})`).map(row => row.name));
const at = (row, name) => row[name] ?? null;
const project = directory => directory ? path.basename(directory) : null;

function opencode(db, file) {
  const result = [];
  const seen = new Set();
  const copiedThrough = new Map();
  if (hasTable(db, 'session_v2') && hasTable(db, 'session_message')) {
    const forkColumns = columns(db, 'session_v2');
    const messageColumns = columns(db, 'session_message');
    if (['id', 'fork_session_id', 'fork_boundary'].every(key => forkColumns.has(key)) &&
      ['id', 'session_id', 'seq'].every(key => messageColumns.has(key))) {
      for (const fork of rows(db, 'SELECT id,fork_session_id,fork_boundary FROM session_v2 WHERE fork_session_id IS NOT NULL')) {
        const boundary = parse(fork.fork_boundary);
        if (!['through', 'before'].includes(boundary?.type) || !boundary.messageID) continue;
        const parent = db.prepare('SELECT seq FROM session_message WHERE session_id=? AND id=?').get(fork.fork_session_id, boundary.messageID);
        if (!parent) continue;
        const cutoff = boundary.type === 'through' ? parent.seq :
          db.prepare('SELECT MAX(seq) AS seq FROM session_message WHERE session_id=? AND seq<?')
            .get(fork.fork_session_id, parent.seq)?.seq;
        if (cutoff != null) copiedThrough.set(fork.id, cutoff);
      }
    }
  }
  for (const table of ['message', 'session_message']) {
    if (!hasTable(db, table)) continue;
    const cols = columns(db, table);
    if (!['id', 'session_id', 'data'].every(key => cols.has(key))) continue;
    const sql = `SELECT id,session_id,data${cols.has('type') ? ',type' : ''}${cols.has('time_created') ? ',time_created' : ''}${cols.has('seq') ? ',seq' : ''} FROM ${table}`;
    for (const row of rows(db, sql)) {
      if (table === 'session_message' && row.type !== 'assistant') continue;
      if (table === 'session_message' && copiedThrough.has(row.session_id) &&
        Number.isFinite(row.seq) && row.seq <= copiedThrough.get(row.session_id)) continue;
      const data = parse(row.data);
      if (!data?.tokens) continue;
      const id = String(first(data.id, row.id));
      if (seen.has(id)) continue;
      const u = data.tokens;
      const r = event('opencode', file, id, date(first(data.time?.created, row.time_created), 0), {
        sessionId: first(data.sessionID, row.session_id),
        model: first(data.modelID, data.model?.modelID, data.model?.id),
        costUsd: number(data.cost),
        ...usage(u.input, u.output, u.cache?.read, u.cache?.write, u.total, u.reasoning),
      });
      if (r) { seen.add(id); result.push(r); }
    }
  }
  return result;
}

function kilo(db, file) {
  if (!hasTable(db, 'message')) return [];
  return rows(db, 'SELECT id,session_id,data FROM message').flatMap(row => {
    const data = parse(row.data);
    if (data?.role !== 'assistant' || !data.tokens) return [];
    const u = data.tokens;
    const r = event('kilo', file, first(data.id, row.id), date(data.time?.created, 0), {
      model: data.modelID, sessionId: first(data.session_id, row.session_id), costUsd: number(data.cost),
      ...usage(u.input, u.output, u.cache?.read, u.cache?.write, u.total, u.reasoning),
    });
    return r ? [r] : [];
  });
}

function goose(db, file) {
  if (!hasTable(db, 'sessions')) return [];
  return rows(db, `SELECT id,model_config_json,provider_name,created_at,total_tokens,input_tokens,output_tokens,
    accumulated_total_tokens,accumulated_input_tokens,accumulated_output_tokens FROM sessions`).flatMap(row => {
    const model = parse(row.model_config_json)?.model_name;
    const input = integer(row.accumulated_input_tokens) || integer(row.input_tokens);
    const output = integer(row.accumulated_output_tokens) || integer(row.output_tokens);
    const total = integer(row.accumulated_total_tokens) || integer(row.total_tokens);
    const r = event('goose', file, row.id, date(row.created_at, 0), {
      sessionId: row.id, model, ...usage(input, output, 0, 0, total),
    });
    return r ? [r] : [];
  });
}

function hermes(db, file) {
  if (!hasTable(db, 'sessions')) return [];
  const fields = ['id', 'model', 'started_at', 'input_tokens', 'output_tokens', 'cache_read_tokens',
    'cache_write_tokens', 'reasoning_tokens', 'estimated_cost_usd', 'actual_cost_usd'];
  if (!fields.slice(0, 5).every(field => columns(db, 'sessions').has(field))) return [];
  const cols = columns(db, 'sessions');
  return rows(db, `SELECT ${fields.map(field => cols.has(field) ? field : `NULL AS ${field}`).join(',')} FROM sessions`).flatMap(row => {
    const r = event('hermes', file, row.id, date(row.started_at, 0), {
      sessionId: row.id, model: row.model, costUsd: number(first(row.actual_cost_usd, row.estimated_cost_usd)),
      ...usage(row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens,
        0, row.reasoning_tokens),
    });
    return r ? [r] : [];
  });
}

function zcode(db, file) {
  if (!hasTable(db, 'model_usage')) return [];
  const cols = columns(db, 'model_usage');
  const required = ['id', 'session_id', 'started_at', 'model_id', 'status', 'input_tokens', 'output_tokens'];
  if (!required.every(field => cols.has(field))) return [];
  const fields = [...required, 'cache_creation_input_tokens', 'cache_read_input_tokens', 'computed_total_tokens'];
  const selected = fields.map(field => cols.has(field) ? `m.${field}` : `NULL AS ${field}`);
  const join = hasTable(db, 'session') ? 'LEFT JOIN session s ON s.id=m.session_id' : '';
  const directory = join && columns(db, 'session').has('directory') ? 's.directory' : 'NULL AS directory';
  return rows(db, `SELECT ${selected.join(',')},${directory} FROM model_usage m ${join} WHERE m.status='completed'`).flatMap(row => {
    const r = event('zcode', file, row.id, date(row.started_at, 0), {
      sessionId: row.session_id, project: project(row.directory), model: row.model_id,
      ...usage(row.input_tokens, row.output_tokens, row.cache_read_input_tokens,
        row.cache_creation_input_tokens, row.computed_total_tokens, 0, { inputIncludesCache: true }),
    });
    return r ? [r] : [];
  });
}

function openclaw(db, file) {
  if (!hasTable(db, 'transcript_events')) return [];
  const result = [];
  let model = null;
  let session = null;
  for (const row of rows(db, 'SELECT session_id,seq,event_json,created_at FROM transcript_events ORDER BY session_id,seq')) {
    if (session !== row.session_id) { session = row.session_id; model = null; }
    const data = parse(row.event_json);
    if (!data) continue;
    if (['model_change', 'model-snapshot'].includes(data.type)) {
      model = first(data.data?.modelId, data.modelId, data.data?.model, data.model, model);
      continue;
    }
    if (data.type !== 'message' || data.message?.role !== 'assistant' || !data.message.usage) continue;
    const u = data.message.usage;
    const r = event('openclaw', file, first(data.id, `${row.session_id}:${row.seq}`),
      date(first(data.timestamp, row.created_at), 0), {
        sessionId: row.session_id, model: first(data.message.modelId, data.message.model, model),
        costUsd: number(u.cost?.total), ...usage(u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens),
      });
    if (r) result.push(r);
  }
  return result;
}

export function collectNativeSqliteFile(source, filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    return { opencode, kilo, goose, hermes, zcode, openclaw }[source](db, filename);
  } finally { db.close(); }
}
