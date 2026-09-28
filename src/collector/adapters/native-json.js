import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { jsonLines } from '../files.js';
import { basename, date, event, first, integer, number, usage } from './native-common.js';

const arr = value => Array.isArray(value) ? value : [];
const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const projectOf = filename => path.basename(path.dirname(filename));
const ts = (value, fallback) => date(value, fallback);
const make = (source, file, key, time, fields) => event(source, file, key, time, fields);

function amp(file, root, fallback) {
  const output = [];
  const sessionId = root.id || basename(file);
  const messages = arr(root.messages);
  if (Array.isArray(root.usageLedger?.events)) {
    const cache = new Map(messages.map(item => [String(first(item.messageId, item.id)), item.usage || {}]));
    root.usageLedger.events.forEach((item, index) => {
      const counts = obj(item.tokens);
      const detail = obj(cache.get(String(item.toMessageId)));
      output.push(make('amp', file, first(item.id, index), ts(item.timestamp, fallback), {
        sessionId, model: item.model, costUsd: null,
        extensions: number(item.credits) != null ? { credits: number(item.credits) } : {},
        ...usage(counts.input, counts.output, first(detail.cacheReadInputTokens, detail.cacheRead),
          first(detail.cacheCreationInputTokens, detail.cacheWrite), counts.total),
      }));
    });
  } else {
    messages.forEach((item, index) => {
      if (item.role !== 'assistant' || !item.usage) return;
      const u = item.usage;
      output.push(make('amp', file, first(item.messageId, index), ts(first(u.timestamp, item.timestamp), fallback), {
        sessionId, model: first(u.model, item.model),
        ...usage(u.inputTokens, u.outputTokens, u.cacheReadInputTokens, u.cacheCreationInputTokens, u.totalTokens),
      }));
    });
  }
  return output.filter(Boolean);
}

function codebuff(file, root, fallback) {
  return arr(root).flatMap((item, index) => {
    if (!['ai', 'agent', 'assistant'].includes(first(item?.variant, item?.role))) return [];
    const m = obj(item.metadata);
    const u = obj(first(m.usage, m.codebuff?.usage,
      m.runState?.sessionState?.mainAgentState?.messageHistory?.findLast(row => row.role === 'assistant')?.providerOptions?.usage));
    const counts = usage(first(u.inputTokens, u.input_tokens, u.promptTokens, u.prompt_tokens),
      first(u.outputTokens, u.output_tokens, u.completionTokens, u.completion_tokens),
      first(u.cacheReadInputTokens, u.cache_read_input_tokens, u.promptTokensDetails?.cachedTokens),
      first(u.cacheCreationInputTokens, u.cache_creation_input_tokens, u.cacheCreationTokens),
      first(u.totalTokens, u.total_tokens, u.total));
    const row = make('codebuff', file, first(item.id, index), ts(first(item.timestamp, item.createdAt, m.timestamp), fallback), {
      sessionId: path.basename(path.dirname(file)), project: path.basename(path.dirname(path.dirname(path.dirname(file)))),
      model: first(m.model, u.model), extensions: number(first(item.credits, u.credits)) != null
        ? { credits: number(first(item.credits, u.credits)) } : {}, ...counts,
    });
    return row ? [row] : [];
  });
}

function droid(file, root, fallback) {
  const u = obj(root.tokenUsage);
  const counts = usage(u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheCreationTokens,
    u.totalTokens, u.thinkingTokens, { reasoningSeparate: true });
  const row = make('droid', file, basename(file), ts(first(root.providerLockTimestamp, root.timestamp), fallback), {
    sessionId: first(root.sessionId, basename(file).replace(/\.settings$/, '')),
    model: root.model, ...counts,
  });
  return row ? [row] : [];
}

function geminiTokens(source, file, key, time, model, sessionId, value, fallback, stats = false) {
  const u = obj(value);
  const input = first(u.input, u.prompt, u.input_tokens, u.prompt_tokens);
  const output = first(u.output, u.candidates, u.output_tokens, u.candidates_tokens);
  const cache = first(u.cached, u.cached_tokens);
  const total = first(u.total, u.total_tokens);
  const thoughts = first(u.thoughts, u.reasoning, u.thoughts_tokens, u.reasoning_tokens);
  const includesCache = stats || (integer(cache) > 0 && integer(total) === integer(input) + integer(output) + integer(thoughts) + integer(first(u.tool, u.tool_tokens)));
  const counts = usage(integer(input) + integer(first(u.tool, u.tool_tokens)), output, cache, 0, total, thoughts,
    { inputIncludesCache: includesCache, reasoningSeparate: true });
  return make(source, file, key, ts(time, fallback), { model, sessionId, ...counts });
}

function gemini(file, rows, fallback) {
  const result = [];
  const root = file.endsWith('.json') ? rows[0] : null;
  let sessionId = first(root?.sessionId, root?.session_id, basename(file));
  const items = root?.messages ? root.messages.map((value, index) => ({ ...value, __line: index })) : rows;
  let model = root?.model || null;
  items.forEach((item, index) => {
    sessionId = first(item.sessionId, item.session_id, sessionId);
    model = first(item.model, model);
    const time = first(item.timestamp, item.created_at, root?.lastUpdated, root?.startTime);
    if (item.type === 'gemini' && item.tokens) {
      result.push(geminiTokens('gemini', file, first(item.id, index), time, first(item.model, model), sessionId, item.tokens, fallback));
      return;
    }
    const stats = first(item.stats, item.result?.stats);
    if (!stats) return;
    if (stats.models) {
      for (const [modelName, data] of Object.entries(stats.models)) {
        result.push(geminiTokens('gemini', file, `${index}:${modelName}`, time, modelName, sessionId, data.tokens, fallback, true));
      }
    } else result.push(geminiTokens('gemini', file, index, time, model, sessionId, stats, fallback, true));
  });
  return result.filter(Boolean);
}

function grok(file, rows, fallback) {
  const result = [];
  rows.forEach((item, index) => {
    const p = obj(item.params);
    if (p.update?.sessionUpdate !== 'turn_completed') return;
    const u = obj(p.update.usage);
    const models = Object.keys(obj(u.modelUsage)).length ? u.modelUsage : { 'grok-unknown': u };
    for (const [model, value] of Object.entries(models)) {
      result.push(make('grok', file, `${first(p._meta?.eventId, index)}:${model}`,
        ts(first(p._meta?.agentTimestampMs, item.timestamp), fallback), {
          model, sessionId: first(p.sessionId, projectOf(file)),
          ...usage(value.inputTokens, value.outputTokens, value.cachedReadTokens, value.cacheCreationTokens,
            value.totalTokens, value.reasoningTokens, { inputIncludesCache: true }),
          costUsd: number(value.costUsdTicks) == null ? null : Number(value.costUsdTicks) / 1e10,
        }));
    }
  });
  return result.filter(Boolean);
}

function kimi(file, rows, fallback) {
  return rows.flatMap((item, index) => {
    let u, time, model;
    if (item.type === 'usage.record' && item.usageScope === 'turn') {
      u = item.usage; time = item.time; model = item.model;
    } else if (item.message?.type === 'StatusUpdate' && item.message.payload?.token_usage) {
      u = item.message.payload.token_usage; time = item.timestamp; model = item.model;
    } else return [];
    const row = make('kimi', file, first(item.message?.payload?.message_id, index), ts(time, fallback), {
      sessionId: path.basename(path.dirname(file)), model: model?.replace(/^kimi-code\//, '') || 'kimi-for-coding',
      ...usage(first(u.inputOther, u.input_other), u.output,
        first(u.inputCacheRead, u.input_cache_read), first(u.inputCacheCreation, u.input_cache_creation), u.total),
    });
    return row ? [row] : [];
  });
}

function qwen(file, rows, fallback) {
  return rows.flatMap((item, index) => {
    const u = item.usageMetadata;
    if (item.type !== 'assistant' || !u) return [];
    const row = make('qwen', file, first(item.id, index), ts(item.timestamp, fallback), {
      sessionId: first(item.sessionId, basename(file)), model: first(item.model, item.message?.model, 'qwen'),
      ...usage(u.promptTokenCount, u.candidatesTokenCount, u.cachedContentTokenCount, 0,
        u.totalTokenCount, u.thoughtsTokenCount, { reasoningSeparate: true }),
    });
    return row ? [row] : [];
  });
}

function pi(file, rows, fallback) {
  if (file.split(path.sep).includes('subagent-artifacts')) return [];
  return rows.flatMap((item, index) => {
    if (item.type !== 'message' || item.message?.role !== 'assistant') return [];
    const u = item.message.usage;
    if (!u) return [];
    const row = make('pi', file, first(item.id, index), ts(item.timestamp, fallback), {
      sessionId: first(rows[0]?.id, basename(file)), model: item.message.model,
      costUsd: number(u.cost?.total),
      ...usage(u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens),
    });
    return row ? [row] : [];
  });
}

function openclaw(file, rows, fallback) {
  let currentModel = null;
  const sessionId = path.basename(file).split('.jsonl')[0];
  return rows.flatMap((item, index) => {
    if (['model_change', 'model-snapshot'].includes(item.type)) {
      currentModel = first(item.data?.modelId, item.data?.model, item.modelId, item.model, currentModel);
      return [];
    }
    if (item.type !== 'message' || item.message?.role !== 'assistant' || !item.message.usage) return [];
    const u = item.message.usage;
    const row = make('openclaw', file, first(item.id, index), ts(first(item.timestamp, item.message.timestamp), fallback), {
      sessionId, model: first(item.message.modelId, item.message.model, currentModel),
      costUsd: number(u.cost?.total),
      ...usage(u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens),
    });
    return row ? [row] : [];
  });
}

function opencode(file, root, fallback) {
  if (!root.tokens) return [];
  const u = root.tokens;
  const row = make('opencode', file, first(root.id, basename(file)), ts(first(root.time?.created, root.timestamp), fallback), {
    sessionId: first(root.sessionID, projectOf(file)), model: root.modelID, costUsd: number(root.cost),
    ...usage(u.input, u.output, u.cache?.read, u.cache?.write, u.total, u.reasoning),
  });
  return row ? [row] : [];
}

function copilot(file, rows, fallback) {
  const result = [];
  const previous = new Map();
  rows.forEach((item, index) => {
    if (item.type === 'session.shutdown') {
      for (const [model, details] of Object.entries(obj(item.data?.modelMetrics))) {
        const u = details.usage;
        if (!u) continue;
        const key = `${path.basename(path.dirname(file))}:${model}`;
        const totals = usage(u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, 0,
          u.reasoningTokens, { inputIncludesCache: true });
        const old = previous.get(key);
        const delta = Object.fromEntries(Object.entries(totals).map(([field, value]) => [field,
          old ? Math.max(0, value - old[field]) : value]));
        previous.set(key, totals);
        result.push(make('copilot', file, `${first(item.id, index)}:${model}`, ts(item.timestamp, fallback), {
          sessionId: path.basename(path.dirname(file)), model, ...delta,
        }));
      }
      return;
    }
    const a = obj(item.attributes);
    const get = key => a[key]?.value?.intValue ?? a[key]?.value?.doubleValue ?? a[key]?.value?.stringValue ?? a[key];
    if (!a['gen_ai.usage.input_tokens'] && !a['gen_ai.usage.output_tokens']) return;
    result.push(make('copilot', file, first(get('gen_ai.response.id'), item.spanId, index),
      ts(first(item.timestamp, item.timeUnixNano ? Number(item.timeUnixNano) / 1e6 : null), fallback), {
        sessionId: first(get('session.id'), get('github.copilot.session_id'), basename(file)),
        model: first(get('gen_ai.request.model'), get('gen_ai.response.model')),
        ...usage(get('gen_ai.usage.input_tokens'), get('gen_ai.usage.output_tokens'),
          get('gen_ai.usage.cache_read.input_tokens'), get('gen_ai.usage.cache_write.input_tokens'),
          get('gen_ai.usage.total_tokens'), get('gen_ai.usage.reasoning.output_tokens'),
          { inputIncludesCache: true }),
      }));
  });
  return result.filter(Boolean);
}

export async function collectNativeJsonFile(source, filename) {
  const fallback = (await stat(filename)).mtime.toISOString();
  if (source === 'amp' || source === 'droid' || source === 'codebuff' || source === 'opencode') {
    const root = JSON.parse(await readFile(filename, 'utf8'));
    return { amp, droid, codebuff, opencode }[source](filename, root, fallback);
  }
  const rows = [];
  if (source === 'gemini' && filename.endsWith('.json')) {
    try { rows.push(JSON.parse(await readFile(filename, 'utf8'))); }
    catch (error) { if (error instanceof SyntaxError) return []; throw error; }
  }
  else for await (const { value } of jsonLines(filename)) rows.push(value);
  return { gemini, grok, kimi, qwen, pi, openclaw, copilot }[source](filename, rows, fallback);
}
