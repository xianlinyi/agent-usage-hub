import { createServer as createHttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeEvent } from '../records.js';
import { UsageDatabase } from './db.js';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function reply(res, status, body, headers = {}) {
  const output = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(output);
}

function authorized(req, expected) {
  const actual = req.headers.authorization?.replace(/^Bearer /i, '') || '';
  if (!expected || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function readBody(req, maxBytes = 2_000_000) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error('Request body exceeds 2 MB');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Request body must be JSON'); }
}

export function createUsageServer({ database, pushToken, adminToken }) {
  const db = database instanceof UsageDatabase ? database : new UsageDatabase(database);
  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      if (req.method === 'GET' && pathname === '/api/v1/health') {
        return reply(res, 200, { ok: true });
      }
      if (req.method === 'GET' && assets[pathname]) {
        const [filename, type] = assets[pathname];
        const body = await readFile(path.join(webRoot, filename));
        res.writeHead(200, {
          'content-type': type,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
        });
        return res.end(body);
      }
      if (req.method === 'POST' && pathname === '/api/v1/events') {
        if (!authorized(req, pushToken)) return reply(res, 401, { error: 'Unauthorized' });
        const payload = await readBody(req);
        if (!payload || typeof payload.collectorId !== 'string' || !Array.isArray(payload.events)) {
          throw new Error('Expected collectorId and events array');
        }
        if (payload.events.length < 1 || payload.events.length > 500) throw new Error('Batch must contain 1–500 events');
        const events = payload.events.map((item, index) => {
          try { return normalizeEvent(item, payload.collectorId); }
          catch (error) { throw new Error(`Event ${index}: ${error.message}`); }
        });
        return reply(res, 200, db.ingest(events));
      }
      if (req.method === 'POST' && pathname.startsWith('/api/v1/files/')) {
        if (!authorized(req, pushToken)) return reply(res, 401, { error: 'Unauthorized' });
        const payload = await readBody(req);
        if (!payload || typeof payload.collectorId !== 'string' || !payload.collectorId.trim() ||
          payload.collectorId.length > 128 || typeof payload.source !== 'string' || !payload.source.trim() ||
          payload.source.length > 64 || !/^[a-f0-9]{24}$/.test(payload.fileKey || '') ||
          !/^[a-f0-9-]{36}$/.test(payload.generation || '')) {
          throw new Error('Invalid file sync identity');
        }
        const { collectorId, source, fileKey, generation } = payload;
        if (pathname === '/api/v1/files/begin') return reply(res, 200, db.beginFile(collectorId, source, fileKey, generation));
        if (pathname === '/api/v1/files/finish') return reply(res, 200, db.finishFile(collectorId, source, fileKey, generation));
        if (pathname === '/api/v1/files/events') {
          if (!Array.isArray(payload.events) || payload.events.length < 1 || payload.events.length > 500) {
            throw new Error('Batch must contain 1–500 events');
          }
          const events = payload.events.map((item, index) => {
            try {
              const normalized = normalizeEvent(item, collectorId);
              if (normalized.source !== source) throw new Error('source must match file sync scope');
              return normalized;
            } catch (error) { throw new Error(`Event ${index}: ${error.message}`); }
          });
          return reply(res, 200, db.ingestFile(collectorId, source, fileKey, generation, events));
        }
      }
      if (req.method === 'POST' && pathname === '/api/v1/snapshots') {
        if (!authorized(req, pushToken)) return reply(res, 401, { error: 'Unauthorized' });
        const payload = await readBody(req);
        if (!payload || typeof payload.collectorId !== 'string' || !payload.collectorId.trim() ||
          payload.collectorId.length > 128 || typeof payload.source !== 'string' || !payload.source.trim() ||
          payload.source.length > 64 || !Array.isArray(payload.events) || payload.events.length > 500) {
          throw new Error('Expected collectorId, source, and up to 500 events');
        }
        const snapshotDate = new Date(`${payload.period}T00:00:00.000Z`);
        if (typeof payload.period !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.period) ||
          Number.isNaN(snapshotDate.getTime()) || snapshotDate.toISOString().slice(0, 10) !== payload.period) {
          throw new Error('Invalid snapshot period');
        }
        const collectorId = payload.collectorId.trim();
        const source = payload.source.trim();
        const events = payload.events.map((item, index) => {
          try {
            const event = normalizeEvent(item, collectorId);
            if (event.source !== source || event.occurredAt.slice(0, 10) !== payload.period) {
              throw new Error('source and occurredAt must match the snapshot scope');
            }
            return event;
          } catch (error) { throw new Error(`Event ${index}: ${error.message}`); }
        });
        if (new Set(events.map(event => event.eventId)).size !== events.length) throw new Error('Snapshot contains duplicate eventId values');
        return reply(res, 200, db.replaceSnapshot(collectorId, source, payload.period, events));
      }
      if (pathname.startsWith('/api/v1/')) {
        if (!authorized(req, adminToken)) return reply(res, 401, { error: 'Unauthorized' });
        if (req.method !== 'GET') return reply(res, 405, { error: 'Method not allowed' });
        if (pathname === '/api/v1/summary') return reply(res, 200, db.summary(url.searchParams));
        if (pathname === '/api/v1/stats') return reply(res, 200, { rows: db.stats(url.searchParams) });
        if (pathname === '/api/v1/events') return reply(res, 200, { rows: db.events(url.searchParams) });
        if (pathname === '/api/v1/fields') return reply(res, 200, db.fields());
      }
      return reply(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = error.status || (error instanceof SyntaxError || /^(Invalid|Unsupported|Expected|Date |Search |Extension |Batch |Event |Request |Snapshot |Port |reasoningTokens|extensions |totalTokens |\w+ must)/.test(error.message) ? 400 : 500);
      if (status === 500) process.stderr.write(`Server error: ${error.message}\n`);
      reply(res, status, { error: status === 500 ? 'Internal server error' : error.message });
    }
  });
  return { server, db };
}

export async function startServer(config, secrets) {
  const pushToken = process.env.AGENT_USAGE_PUSH_TOKEN || secrets.pushToken;
  const adminToken = process.env.AGENT_USAGE_ADMIN_TOKEN || secrets.adminToken;
  if (!pushToken || !adminToken) throw new Error('Server push and admin tokens are required');
  const { server, db } = createUsageServer({ database: config.database, pushToken, adminToken });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  return { server, db };
}
