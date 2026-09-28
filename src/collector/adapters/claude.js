import { createHash } from 'node:crypto';
import path from 'node:path';
import { jsonLines } from '../files.js';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const token = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export async function* collectClaudeFile(filename) {
  const fileId = hash(path.resolve(filename));
  const latest = new Map();
  const preferred = new Map();
  for await (const { number, value } of jsonLines(filename)) {
    if (value.type !== 'assistant' || !value.message?.usage) continue;
    const usage = value.message.usage;
    const id = value.message.id && value.requestId
      ? `claude:${hash(`${value.message.id}:${value.requestId}`)}`
      : `claude:${fileId}:${number}`;
    const candidate = {
      eventId: id, source: 'claude', agent: 'claude',
      model: value.message.model || null,
      project: value.cwd ? path.basename(value.cwd) : null,
      sessionId: value.sessionId || path.basename(filename, '.jsonl'),
      occurredAt: value.timestamp,
      inputTokens: token(usage.input_tokens), outputTokens: token(usage.output_tokens),
      cacheReadTokens: token(usage.cache_read_input_tokens),
      cacheWriteTokens: token(usage.cache_creation_input_tokens),
      reasoningTokens: 0, extensions: {},
    };
    const replayKey = value.message.id ? `${candidate.sessionId}:${value.message.id}` : null;
    const parent = replayKey && preferred.get(replayKey);
    if (value.isSidechain === true && parent && parent.sidechain === false) continue;
    if (value.isSidechain !== true && parent?.sidechain === true) {
      latest.delete(parent.id);
      for (const key of latest.keys()) if (key.startsWith(`${parent.id}:advisor:`)) latest.delete(key);
    }
    if (replayKey && (!parent || value.isSidechain !== true)) {
      preferred.set(replayKey, { id, sidechain: value.isSidechain === true });
    }
    const previous = latest.get(id);
    if (!previous || candidate.inputTokens + candidate.outputTokens + candidate.cacheReadTokens + candidate.cacheWriteTokens >=
      previous.inputTokens + previous.outputTokens + previous.cacheReadTokens + previous.cacheWriteTokens) {
      latest.set(id, { ...candidate, occurredAt: previous?.occurredAt || candidate.occurredAt });
    }
    for (const [index, advisor] of (Array.isArray(usage.iterations) ? usage.iterations : []).entries()) {
      if (advisor.type !== 'advisor_message' || !advisor.model) continue;
      const advisorId = `${id}:advisor:${index}`;
      const record = {
        ...candidate, eventId: advisorId, model: advisor.model,
        inputTokens: token(advisor.input_tokens), outputTokens: token(advisor.output_tokens),
        cacheReadTokens: token(advisor.cache_read_input_tokens),
        cacheWriteTokens: token(advisor.cache_creation_input_tokens),
      };
      if (record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens > 0) {
        latest.set(advisorId, record);
      }
    }
  }
  yield* latest.values();
}
