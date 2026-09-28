import { createHash } from 'node:crypto';
import path from 'node:path';

export const integer = value => Number.isFinite(Number(value)) && Number(value) > 0
  ? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(Number(value))) : 0;
export const number = value => value !== null && value !== undefined && value !== '' &&
  Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
export const first = (...values) => values.find(value => value !== undefined && value !== null && value !== '') ?? null;
export const name = value => typeof value === 'string' && value.trim() ? value.trim() : null;
export const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
export const basename = filename => path.basename(filename, path.extname(filename));
export const date = (value, fallback) => {
  if (value == null) return new Date(fallback).toISOString();
  const numeric = Number(value);
  const parsed = typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))
    ? new Date(numeric < 1e11 ? numeric * 1000 : numeric) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(fallback).toISOString() : parsed.toISOString();
};

export function usage(input, output, cacheRead = 0, cacheWrite = 0, total = 0, reasoning = 0,
  { inputIncludesCache = false, reasoningSeparate = false } = {}) {
  const read = integer(cacheRead);
  const write = integer(cacheWrite);
  const rawInput = integer(input);
  const baseInput = inputIncludesCache ? Math.max(0, rawInput - read - write) : rawInput;
  const separate = reasoningSeparate ? integer(reasoning) : 0;
  let out = integer(output) + separate;
  const missing = Math.max(0, integer(total) - baseInput - out - read - write);
  const filledOutput = out === 0 && missing > 0;
  if (filledOutput) out = missing;
  const extra = filledOutput ? 0 : missing;
  return {
    inputTokens: baseInput, outputTokens: out, cacheReadTokens: read, cacheWriteTokens: write,
    otherTokens: extra, reasoningTokens: Math.min(integer(reasoning), out),
  };
}

export function event(source, filename, key, timestamp, fields = {}) {
  const { model = null, project = null, sessionId = basename(filename), costUsd = null, extensions = {}, ...tokens } = fields;
  const count = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'otherTokens']
    .reduce((sum, field) => sum + (tokens[field] || 0), 0);
  if (!count || !timestamp) return null;
  return {
    eventId: `${source}:${hash(path.resolve(filename))}:${hash(key)}`, source, agent: source,
    model: name(model), project: name(project), sessionId: name(sessionId),
    occurredAt: timestamp, costUsd: number(costUsd), extensions, ...tokens,
  };
}
