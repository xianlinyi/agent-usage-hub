import { createHash } from 'node:crypto';

const textLimits = {
  eventId: 256, collectorId: 128, source: 64, agent: 128,
  model: 256, project: 256, sessionId: 256,
};
const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'otherTokens', 'reasoningTokens'];

function cleanText(value, name, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || value.length > textLimits[name] || (required && !value.trim())) {
    throw new Error(`${name} must be a nonempty string of at most ${textLimits[name]} characters`);
  }
  return value.trim();
}

export function normalizeEvent(raw, collectorId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Event must be an object');
  const occurredAt = new Date(raw.occurredAt);
  if (!raw.occurredAt || Number.isNaN(occurredAt.getTime())) throw new Error('occurredAt must be an ISO date-time');
  const event = {
    eventId: cleanText(raw.eventId, 'eventId', true),
    collectorId: cleanText(collectorId, 'collectorId', true),
    source: cleanText(raw.source, 'source', true),
    agent: cleanText(raw.agent || raw.source, 'agent', true),
    model: cleanText(raw.model, 'model'),
    project: cleanText(raw.project, 'project'),
    sessionId: cleanText(raw.sessionId, 'sessionId'),
    occurredAt: occurredAt.toISOString(),
  };
  for (const key of tokenFields) {
    const value = raw[key] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a nonnegative safe integer`);
    event[key] = value;
  }
  if (event.reasoningTokens > event.outputTokens) throw new Error('reasoningTokens cannot exceed outputTokens');
  const cost = raw.costUsd;
  if (cost != null && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) {
    throw new Error('costUsd must be a nonnegative number or null');
  }
  event.costUsd = cost ?? null;
  const extensions = raw.extensions ?? {};
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) throw new Error('extensions must be an object');
  for (const [key, value] of Object.entries(extensions)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(key)) throw new Error(`Invalid extension field: ${key}`);
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`Extension ${key} must be a string, number, boolean, or null`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Extension ${key} must be finite`);
    if (typeof value === 'string' && value.length > 2048) throw new Error(`Extension ${key} exceeds 2048 characters`);
  }
  if (Buffer.byteLength(JSON.stringify(extensions)) > 16_384) throw new Error('extensions exceed 16 KiB');
  event.extensions = Object.fromEntries(Object.entries(extensions).sort(([a], [b]) => a.localeCompare(b)));
  event.totalTokens = event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens + event.otherTokens;
  if (!Number.isSafeInteger(event.totalTokens)) throw new Error('totalTokens exceed safe integer range');
  event.contentHash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
  return event;
}

export const baseFields = ['collectorId', 'source', 'agent', 'model', 'project', 'sessionId'];
export const baseMetrics = ['events', 'totalTokens', ...tokenFields, 'costUsd'];
