import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { baseFields, baseMetrics } from '../records.js';

const column = {
  collectorId: 'collector_id', source: 'source', agent: 'agent', model: 'model',
  project: 'project', sessionId: 'session_id',
};
const numericColumn = {
  inputTokens: 'input_tokens', outputTokens: 'output_tokens',
  cacheReadTokens: 'cache_read_tokens', cacheWriteTokens: 'cache_write_tokens',
  otherTokens: 'other_tokens', reasoningTokens: 'reasoning_tokens', costUsd: 'cost_usd',
};

function extensionName(name) {
  const match = /^ext\.([a-zA-Z_][a-zA-Z0-9_-]{0,63})$/.exec(name || '');
  if (!match) throw new Error(`Invalid extension field: ${name}`);
  return match[1];
}

function fieldExpression(field) {
  if (column[field]) return column[field];
  if (field?.startsWith('ext.')) return `json_extract(extensions, '$."${extensionName(field)}"')`;
  throw new Error(`Unsupported field: ${field}`);
}

function metricExpression(metric, extensionTypes) {
  if (metric === 'events') return 'count(*)';
  if (metric === 'totalTokens') return 'sum(total_tokens)';
  if (numericColumn[metric]) return `sum(${numericColumn[metric]})`;
  if (metric?.startsWith('ext.')) {
    const key = extensionName(metric);
    if (extensionTypes.get(key) !== 'number') throw new Error(`Extension metric is not numeric: ${key}`);
    return `sum(CASE WHEN json_type(extensions, '$."${key}"') IN ('integer','real') THEN json_extract(extensions, '$."${key}"') ELSE 0 END)`;
  }
  throw new Error(`Unsupported metric: ${metric}`);
}

function dateBoundary(value, end = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('Date must use YYYY-MM-DD');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Invalid date');
  if (end) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

function parseFilters(searchParams) {
  const clauses = [];
  const params = [];
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  if (from) { clauses.push('occurred_at >= ?'); params.push(dateBoundary(from)); }
  if (to) { clauses.push('occurred_at < ?'); params.push(dateBoundary(to, true)); }
  for (const [key, value] of searchParams) {
    if (!key.startsWith('filter.')) continue;
    const field = key.slice('filter.'.length);
    const expression = fieldExpression(field);
    if (field.startsWith('ext.')) {
      const extension = extensionName(field);
      clauses.push(`(CAST(${expression} AS TEXT) = ? OR json_type(extensions, '$."${extension}"') = ?)`);
      params.push(value, ['true', 'false'].includes(value) ? value : '__no_match__');
    } else {
      clauses.push(`${expression} = ?`);
      params.push(value);
    }
  }
  const q = searchParams.get('q');
  if (q) {
    if (q.length > 200) throw new Error('Search text is too long');
    const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    clauses.push(`(agent LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\' OR extensions LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern, pattern, pattern, pattern);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export class UsageDatabase {
  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events (
        collector_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        source TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT,
        project TEXT,
        session_id TEXT,
        occurred_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        other_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        cost_usd REAL,
        extensions TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (collector_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS events_time ON events (occurred_at);
      CREATE INDEX IF NOT EXISTS events_agent_time ON events (agent, occurred_at);
      CREATE INDEX IF NOT EXISTS events_source_time ON events (source, occurred_at);
      CREATE TABLE IF NOT EXISTS extension_fields (
        name TEXT PRIMARY KEY,
        data_type TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_events (
        collector_id TEXT NOT NULL,
        source TEXT NOT NULL,
        file_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        generation TEXT NOT NULL,
        PRIMARY KEY (collector_id, source, file_key, event_id)
      );
      CREATE INDEX IF NOT EXISTS file_events_event ON file_events (collector_id, event_id);
      CREATE TABLE IF NOT EXISTS file_sync (
        collector_id TEXT NOT NULL,
        source TEXT NOT NULL,
        file_key TEXT NOT NULL,
        generation TEXT NOT NULL,
        PRIMARY KEY (collector_id, source, file_key)
      );
    `);
    this.existing = this.db.prepare('SELECT content_hash FROM events WHERE collector_id = ? AND event_id = ?');
    this.snapshotRows = this.db.prepare("SELECT event_id,content_hash FROM events WHERE collector_id = ? AND source = ? AND substr(occurred_at,1,10) = ?");
    this.deleteEvent = this.db.prepare('DELETE FROM events WHERE collector_id = ? AND event_id = ?');
    this.upsert = this.db.prepare(`
      INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(collector_id,event_id) DO UPDATE SET
        source=excluded.source, agent=excluded.agent, model=excluded.model,
        project=excluded.project, session_id=excluded.session_id,
        occurred_at=excluded.occurred_at, input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens, cache_read_tokens=excluded.cache_read_tokens,
        cache_write_tokens=excluded.cache_write_tokens, other_tokens=excluded.other_tokens,
        reasoning_tokens=excluded.reasoning_tokens,
        total_tokens=excluded.total_tokens, cost_usd=excluded.cost_usd,
        extensions=excluded.extensions, content_hash=excluded.content_hash
    `);
    this.upsertField = this.db.prepare(`
      INSERT INTO extension_fields (name,data_type) VALUES (?,?)
      ON CONFLICT(name) DO UPDATE SET data_type = CASE
        WHEN extension_fields.data_type = excluded.data_type THEN extension_fields.data_type
        ELSE 'mixed' END
    `);
    this.setFileSync = this.db.prepare(`INSERT INTO file_sync VALUES (?,?,?,?)
      ON CONFLICT(collector_id,source,file_key) DO UPDATE SET generation=excluded.generation`);
    this.currentFileSync = this.db.prepare('SELECT generation FROM file_sync WHERE collector_id=? AND source=? AND file_key=?');
    this.markFileEvent = this.db.prepare(`INSERT INTO file_events VALUES (?,?,?,?,?)
      ON CONFLICT(collector_id,source,file_key,event_id) DO UPDATE SET generation=excluded.generation`);
    this.staleFileEvents = this.db.prepare('SELECT event_id FROM file_events WHERE collector_id=? AND source=? AND file_key=? AND generation<>?');
    this.deleteStaleFileEvents = this.db.prepare('DELETE FROM file_events WHERE collector_id=? AND source=? AND file_key=? AND generation<>?');
    this.hasFileEvent = this.db.prepare('SELECT 1 FROM file_events WHERE collector_id=? AND event_id=? LIMIT 1');
    this.clearFileSync = this.db.prepare('DELETE FROM file_sync WHERE collector_id=? AND source=? AND file_key=?');
  }

  close() { this.db.close(); }

  applyEvent(event, previous, result) {
    if (previous?.content_hash === event.contentHash) {
      result.unchanged++;
      return;
    }
    this.upsert.run(
          event.collectorId, event.eventId, event.source, event.agent, event.model,
          event.project, event.sessionId, event.occurredAt, event.inputTokens,
          event.outputTokens, event.cacheReadTokens, event.cacheWriteTokens,
          event.otherTokens, event.reasoningTokens, event.totalTokens, event.costUsd,
          JSON.stringify(event.extensions), event.contentHash,
    );
    result[previous ? 'updated' : 'inserted']++;
    for (const [name, value] of Object.entries(event.extensions)) {
      if (value !== null) this.upsertField.run(name, typeof value);
    }
  }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  ingest(events) {
    return this.transaction(() => {
      const result = { inserted: 0, updated: 0, unchanged: 0 };
      for (const event of events) {
        this.applyEvent(event, this.existing.get(event.collectorId, event.eventId), result);
      }
      return result;
    });
  }

  beginFile(collectorId, source, fileKey, generation) {
    return this.transaction(() => { this.setFileSync.run(collectorId, source, fileKey, generation); return { ready: true }; });
  }

  ingestFile(collectorId, source, fileKey, generation, events) {
    return this.transaction(() => {
      if (this.currentFileSync.get(collectorId, source, fileKey)?.generation !== generation) {
        throw new Error('Invalid file generation');
      }
      const result = { inserted: 0, updated: 0, unchanged: 0 };
      for (const event of events) {
        this.applyEvent(event, this.existing.get(collectorId, event.eventId), result);
        this.markFileEvent.run(collectorId, source, fileKey, event.eventId, generation);
      }
      return result;
    });
  }

  finishFile(collectorId, source, fileKey, generation) {
    return this.transaction(() => {
      if (this.currentFileSync.get(collectorId, source, fileKey)?.generation !== generation) {
        throw new Error('Invalid file generation');
      }
      const stale = this.staleFileEvents.all(collectorId, source, fileKey, generation);
      this.deleteStaleFileEvents.run(collectorId, source, fileKey, generation);
      let deleted = 0;
      for (const row of stale) {
        if (!this.hasFileEvent.get(collectorId, row.event_id)) {
          this.deleteEvent.run(collectorId, row.event_id);
          deleted++;
        }
      }
      this.clearFileSync.run(collectorId, source, fileKey);
      return { deleted };
    });
  }

  replaceSnapshot(collectorId, source, period, events) {
    return this.transaction(() => {
      const result = { inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
      const previous = new Map(this.snapshotRows.all(collectorId, source, period).map(row => [row.event_id, row]));
      const incoming = new Set();
      for (const event of events) {
        incoming.add(event.eventId);
        this.applyEvent(event, previous.get(event.eventId), result);
      }
      for (const eventId of previous.keys()) {
        if (!incoming.has(eventId)) {
          this.deleteEvent.run(collectorId, eventId);
          result.deleted++;
        }
      }
      return result;
    });
  }

  extensionTypes() {
    return new Map(this.db.prepare('SELECT name,data_type FROM extension_fields ORDER BY name').all().map(row => [row.name, row.data_type]));
  }

  fields() {
    const types = this.extensionTypes();
    return {
      dimensions: ['day', 'month', ...baseFields, ...[...types.keys()].map(name => `ext.${name}`)],
      metrics: [...baseMetrics, ...[...types].filter(([, type]) => type === 'number').map(([name]) => `ext.${name}`)],
      extensions: Object.fromEntries(types),
    };
  }

  summary(searchParams) {
    const { where, params } = parseFilters(searchParams);
    const row = this.db.prepare(`SELECT count(*) AS events, coalesce(sum(total_tokens),0) AS totalTokens,
      coalesce(sum(input_tokens),0) AS inputTokens, coalesce(sum(output_tokens),0) AS outputTokens,
      coalesce(sum(cache_read_tokens),0) AS cacheReadTokens,
      coalesce(sum(cache_write_tokens),0) AS cacheWriteTokens,
      coalesce(sum(other_tokens),0) AS otherTokens,
      coalesce(sum(reasoning_tokens),0) AS reasoningTokens,
      sum(cost_usd) AS costUsd, count(cost_usd) AS costKnownEvents FROM events ${where}`).get(...params);
    return row;
  }

  stats(searchParams) {
    const groupBy = searchParams.get('groupBy') || 'day';
    const metric = searchParams.get('metric') || 'totalTokens';
    const groupExpr = groupBy === 'day' ? 'substr(occurred_at,1,10)' :
      groupBy === 'month' ? 'substr(occurred_at,1,7)' : fieldExpression(groupBy);
    const valueExpr = metricExpression(metric, this.extensionTypes());
    const { where, params } = parseFilters(searchParams);
    const limit = Math.min(Math.max(Number(searchParams.get('limit') || 100), 1), 500);
    if (!Number.isInteger(limit)) throw new Error('Invalid limit');
    const order = ['day', 'month'].includes(groupBy) ? 'label DESC' : 'value DESC';
    return this.db.prepare(`SELECT ${groupExpr} AS label, ${valueExpr} AS value, count(*) AS events
      FROM events ${where} GROUP BY ${groupExpr} ORDER BY ${order} LIMIT ?`).all(...params, limit);
  }

  events(searchParams) {
    const { where, params } = parseFilters(searchParams);
    const limit = Number(searchParams.get('limit') || 50);
    const offset = Number(searchParams.get('offset') || 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) {
      throw new Error('Invalid pagination');
    }
    const rows = this.db.prepare(`SELECT collector_id AS collectorId, event_id AS eventId,
      source, agent, model, project, session_id AS sessionId, occurred_at AS occurredAt,
      input_tokens AS inputTokens, output_tokens AS outputTokens,
      cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens,
      other_tokens AS otherTokens,
      reasoning_tokens AS reasoningTokens, total_tokens AS totalTokens,
      cost_usd AS costUsd, extensions FROM events ${where}
      ORDER BY occurred_at DESC, collector_id, event_id LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return rows.map(row => ({ ...row, extensions: JSON.parse(row.extensions) }));
  }
}
