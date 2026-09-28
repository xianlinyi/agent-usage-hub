import { createHash } from 'node:crypto';
import path from 'node:path';
import { jsonLines } from '../files.js';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const token = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

function rawUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const input = token(value.input_tokens ?? value.prompt_tokens ?? value.input);
  const output = token(value.output_tokens ?? value.completion_tokens ?? value.output);
  const cache = Math.min(input, token(value.cached_input_tokens ?? value.cache_read_input_tokens ?? value.cached_tokens));
  const cacheWrite = Math.min(input - cache, token(value.cache_write_input_tokens ?? value.cache_creation_input_tokens));
  return {
    input, output, cache, cacheWrite,
    reasoning: token(value.reasoning_output_tokens ?? value.reasoning_tokens),
    total: token(value.total_tokens) || input + output,
  };
}

function delta(current, previous) {
  return {
    input: Math.max(0, current.input - previous.input),
    output: Math.max(0, current.output - previous.output),
    cache: Math.max(0, current.cache - previous.cache),
    cacheWrite: Math.max(0, current.cacheWrite - previous.cacheWrite),
    reasoning: Math.max(0, current.reasoning - previous.reasoning),
    total: Math.max(0, current.total - previous.total),
  };
}

export async function* collectCodexFile(filename) {
  let forked = false;
  let replayBoundary = null;
  const firstUsageTimes = [];
  for await (const { value } of jsonLines(filename)) {
    if (value.type === 'session_meta') forked = Boolean(value.payload?.forked_from_id ||
      value.payload?.source?.subagent?.thread_spawn?.parent_thread_id);
    break;
  }
  if (forked) for await (const { number, value } of jsonLines(filename)) {
    if ((value.type === 'event_msg' && value.payload?.type === 'task_started') ||
      (['inter_agent_communication', 'inter_agent_communication_metadata'].includes(value.type) &&
        value.payload?.trigger_turn === true)) replayBoundary ??= number;
    if (value.type === 'event_msg' && value.payload?.type === 'token_count' && firstUsageTimes.length < 2) {
      firstUsageTimes.push(Date.parse(value.timestamp));
    }
  }
  let burstUntil = null;
  if (forked && replayBoundary == null && firstUsageTimes.length === 2 &&
    firstUsageTimes[1] >= firstUsageTimes[0] && firstUsageTimes[1] - firstUsageTimes[0] <= 1000) {
    burstUntil = firstUsageTimes[1];
  }
  const fileId = hash(path.resolve(filename));
  let sessionId = path.basename(filename, '.jsonl');
  let project = null;
  let model = null;
  let previous = { input: 0, output: 0, cache: 0, cacheWrite: 0, reasoning: 0, total: 0 };
  for await (const { number, value } of jsonLines(filename)) {
    if (value.type === 'session_meta') {
      sessionId = value.payload?.id || sessionId;
      if (value.payload?.cwd) project = path.basename(value.payload.cwd);
    }
    if (value.type === 'turn_context' && value.payload?.model) model = value.payload.model;
    if (value.type !== 'event_msg' || value.payload?.type !== 'token_count') continue;
    const info = value.payload.info;
    const total = rawUsage(info?.total_token_usage);
    const last = rawUsage(info?.last_token_usage);
    if (!total && !last) continue;
    let usage;
    if (total) {
      const rolledBack = total.input < previous.input || total.output < previous.output ||
        total.cache < previous.cache || total.cacheWrite < previous.cacheWrite || total.reasoning < previous.reasoning;
      const unchanged = total.input === previous.input && total.output === previous.output &&
        total.cache === previous.cache && total.cacheWrite === previous.cacheWrite && total.reasoning === previous.reasoning;
      usage = unchanged ? delta(total, total) : (last || (rolledBack ? total : delta(total, previous)));
      previous = total;
    } else usage = last;
    if (usage.input + usage.output + usage.cache + usage.cacheWrite === 0) continue;
    if (forked && replayBoundary != null && number < replayBoundary) continue;
    if (burstUntil != null && Date.parse(value.timestamp) <= burstUntil + 1000) {
      burstUntil = Date.parse(value.timestamp);
      continue;
    }
    yield {
      eventId: `codex:${fileId}:${number}`, source: 'codex', agent: 'codex',
      model, project, sessionId, occurredAt: value.timestamp,
      inputTokens: Math.max(0, usage.input - usage.cache - usage.cacheWrite),
      outputTokens: usage.output, cacheReadTokens: usage.cache,
      cacheWriteTokens: usage.cacheWrite, reasoningTokens: Math.min(usage.reasoning, usage.output),
      otherTokens: Math.max(0, usage.total - usage.input - usage.output),
      extensions: {},
    };
  }
}
