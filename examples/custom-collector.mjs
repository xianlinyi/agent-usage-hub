// Configure in collector.json:
// "plugins": [{ "path": "/absolute/path/custom-collector.mjs", "config": { "file": "/absolute/path/usage.jsonl" } }]
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export default async function* collect({ config }) {
  if (!config.file) throw new Error('custom-collector requires config.file');
  const lines = createInterface({ input: createReadStream(config.file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    yield {
      eventId: `my-app:${record.id}`, // Stable across repeated scans.
      source: 'my-app',
      agent: record.agent || 'my-app',
      model: record.model || null,
      project: record.project || null,
      sessionId: record.sessionId || null,
      occurredAt: record.timestamp,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: record.cacheReadTokens || 0,
      cacheWriteTokens: record.cacheWriteTokens || 0,
      otherTokens: 0,
      reasoningTokens: record.reasoningTokens || 0,
      costUsd: record.costUsd ?? null,
      extensions: {
        team: record.team || 'unknown',
        latency_ms: record.latencyMs || 0,
      },
    };
  }
}
