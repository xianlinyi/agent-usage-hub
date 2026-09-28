import { DatabaseSync } from 'node:sqlite';
import { stat } from 'node:fs/promises';
import { date, event, first, integer, usage } from './native-common.js';

// Antigravity stores token counters in protobuf blobs inside a SQLite database.
// Only wire types and fields needed for usage metadata are decoded here.
function fields(blob) {
  if (!(blob instanceof Uint8Array)) return new Map();
  const out = new Map();
  let offset = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= blob.length) throw new Error('Truncated Antigravity protobuf');
      const byte = blob[offset++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid Antigravity protobuf varint');
  };
  while (offset < blob.length) {
    const tag = Number(varint());
    const field = tag >> 3;
    const wire = tag & 7;
    if (!field) throw new Error('Invalid Antigravity protobuf field');
    let value;
    if (wire === 0) value = Number(varint());
    else if (wire === 2) {
      const length = Number(varint());
      if (length > blob.length - offset) throw new Error('Truncated Antigravity protobuf bytes');
      value = blob.subarray(offset, offset + length);
      offset += length;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > blob.length) throw new Error('Truncated Antigravity protobuf fixed value');
      continue;
    } else throw new Error('Unsupported Antigravity protobuf wire type');
    if (!out.has(field)) out.set(field, []);
    out.get(field).push(value);
  }
  return out;
}

const one = (map, field) => map.get(field)?.[0];
const all = (map, field) => map.get(field) || [];
const nested = (map, field) => fields(one(map, field));
const text = (map, field) => {
  const value = one(map, field);
  return value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : null;
};
const timestamp = map => {
  const seconds = one(map, 1);
  return seconds ? date(seconds * 1000 + Math.floor((one(map, 2) || 0) / 1e6), 0) : null;
};
const modelName = (textModel, id) => textModel || (id ? `antigravity-model-${id}` : 'gemini-internal-model');

function usageRow(blob, context) {
  const m = fields(blob);
  const input = integer(one(m, 2));
  const totalOutput = Math.max(integer(one(m, 3)), integer(one(m, 10)) + integer(one(m, 9)));
  const cacheWrite = integer(one(m, 4));
  const cacheRead = integer(one(m, 5));
  if (!input && !totalOutput && !cacheWrite && !cacheRead) return null;
  const response = first(text(m, 11), text(m, 12), text(m, 7));
  return {
    identity: response,
    row: event('antigravity', context.file, response || context.key, context.time, {
      sessionId: context.sessionId, model: modelName(context.model, one(m, 1) || context.modelId),
      ...usage(input, totalOutput, cacheRead, cacheWrite, 0, one(m, 9)),
    }),
  };
}

function retryRows(map, field, context) {
  return all(map, field).map((blob, index) => usageRow(one(fields(blob), 2), {
    ...context, key: `${context.key}:retry:${index}`,
  })).filter(Boolean);
}

export async function collectAntigravityFile(filename) {
  const fallback = (await stat(filename)).mtime.toISOString();
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const result = [];
    const sessionId = filename.split('/').at(-1).replace(/\.db$/, '');
    const generation = db.prepare("SELECT name FROM sqlite_master WHERE name='gen_metadata'").get();
    if (!generation) return [];
    let index = 0;
    const tableRows = [
      ['steps', 'SELECT idx,metadata AS data FROM steps ORDER BY idx'],
      ['gen_metadata', 'SELECT idx,data FROM gen_metadata ORDER BY idx'],
    ];
    for (const [table, sql] of tableRows) {
      if (!db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table)) continue;
      for (const row of db.prepare(sql).iterate()) {
        const outer = fields(row.data);
        const chat = table === 'steps' ? outer : nested(outer, 1);
        const modelInfo = table === 'steps' ? nested(chat, 24) : chat;
        const model = table === 'steps' ? first(text(modelInfo, 12), text(modelInfo, 8))
          : first(text(modelInfo, 19), text(modelInfo, 21));
        const modelId = table === 'steps' ? one(modelInfo, 1) : one(modelInfo, 3);
        const time = table === 'steps'
          ? first(timestamp(nested(chat, 8)), timestamp(nested(chat, 1)), fallback)
          : first(timestamp(nested(nested(chat, 9), 4)), fallback);
        const context = { file: filename, sessionId, model, modelId, time, key: `${table}:${row.idx}:${index++}` };
        const value = one(chat, table === 'steps' ? 9 : 4);
        if (value) result.push(usageRow(value, context));
        result.push(...retryRows(chat, table === 'steps' ? 28 : 17, context));
      }
    }
    const dedup = new Map();
    for (const item of result.filter(Boolean)) {
      const key = item.identity || item.row.eventId;
      const previous = dedup.get(key);
      if (!previous || item.row.inputTokens + item.row.outputTokens + item.row.cacheReadTokens + item.row.cacheWriteTokens >
        previous.inputTokens + previous.outputTokens + previous.cacheReadTokens + previous.cacheWriteTokens) dedup.set(key, item.row);
    }
    return [...dedup.values()];
  } finally { db.close(); }
}
