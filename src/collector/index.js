import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeEvent } from '../records.js';
import { resolvePushToken } from '../config.js';
import { jsonLines } from './files.js';
import { collectSourceFile, sourceFiles } from './sources.js';
import { hash } from './adapters/native-common.js';
import { beginFile, finishFile, pushEvents, pushFileEvents } from './client.js';

async function readState(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { files: {} }; throw error; }
}

async function saveState(filename, state) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temp, filename);
}

async function sendStream(config, token, stream, counts) {
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const result = await pushEvents(config, token, batch);
    for (const key of ['inserted', 'updated', 'unchanged']) counts[key] += result[key] || 0;
    batch = [];
  };
  for await (const item of stream) {
    const event = { ...item, extensions: { ...(item.extensions || {}), ...(config.extensions || {}) } };
    normalizeEvent(event, config.collectorId);
    batch.push(event);
    if (batch.length >= 250) await flush();
  }
  await flush();
}

async function sendSourceFile(config, token, source, filename, counts, includeEvents = true) {
  const fileKey = hash(path.resolve(filename));
  const generation = randomUUID();
  await beginFile(config, token, source, fileKey, generation);
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const result = await pushFileEvents(config, token, source, fileKey, generation, batch);
    for (const key of ['inserted', 'updated', 'unchanged']) counts[key] += result[key] || 0;
    batch = [];
  };
  if (includeEvents) {
    for await (const item of collectSourceFile(source, filename)) {
      const record = { ...item, extensions: { ...(item.extensions || {}), ...(config.extensions || {}) } };
      normalizeEvent(record, config.collectorId);
      batch.push(record);
      if (batch.length >= 250) await flush();
    }
    await flush();
  }
  const result = await finishFile(config, token, source, fileKey, generation);
  counts.deleted += result.deleted || 0;
}

async function* pluginEvents(plugin, config) {
  const filename = path.resolve(plugin.path || plugin);
  const module = await import(pathToFileURL(filename).href);
  if (typeof module.default !== 'function') throw new Error(`Plugin must export a default function: ${filename}`);
  const events = module.default({ config: plugin.config || {}, collector: config });
  if (!events || typeof events[Symbol.asyncIterator] !== 'function' && typeof events[Symbol.iterator] !== 'function') {
    throw new Error(`Plugin must return an iterable: ${filename}`);
  }
  yield* events;
}

export async function collectOnce(config, { full = false } = {}) {
  const token = await resolvePushToken(config);
  if (!token) throw new Error(`Push token is missing; set ${config.tokenEnv || 'AGENT_USAGE_PUSH_TOKEN'} or tokenFile`);
  const state = await readState(config.stateFile);
  const counts = { files: 0, skippedFiles: 0, inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
  for (const source of config.sources || []) {
    const seen = new Set();
    for await (const { filename, info } of sourceFiles(source, config.paths)) {
        seen.add(filename);
        const fingerprint = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        // SQLite may append to a WAL without changing the main database file.
        if (!full && !/\.(?:db|sqlite)$/.test(filename) && state.files?.[filename]?.fingerprint === fingerprint) {
          counts.skippedFiles++;
          continue;
        }
        await sendSourceFile(config, token, source, filename, counts);
        state.files ||= {};
        state.files[filename] = { fingerprint, source };
        counts.files++;
        await saveState(config.stateFile, state);
    }
    for (const [filename, entry] of Object.entries(state.files || {})) {
      if (entry?.source !== source || seen.has(filename)) continue;
      await sendSourceFile(config, token, source, filename, counts, false);
      delete state.files[filename];
      await saveState(config.stateFile, state);
    }
  }
  for (const plugin of config.plugins || []) {
    await sendStream(config, token, pluginEvents(plugin, config), counts);
  }
  return counts;
}

export async function pushFile(config, filename) {
  const token = await resolvePushToken(config);
  const counts = { inserted: 0, updated: 0, unchanged: 0 };
  if (filename.endsWith('.jsonl')) {
    await sendStream(config, token, (async function* () {
      for await (const line of jsonLines(filename)) yield line.value;
    })(), counts);
  } else {
    const value = JSON.parse(await readFile(filename, 'utf8'));
    if (!Array.isArray(value)) throw new Error('JSON file must contain an array of events');
    await sendStream(config, token, value, counts);
  }
  return counts;
}

export async function watchCollector(config, onResult = () => {}) {
  const interval = Number(config.intervalSeconds || 60);
  if (!Number.isInteger(interval) || interval < 5) throw new Error('intervalSeconds must be at least 5');
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopped) {
      try { onResult(null, await collectOnce(config)); }
      catch (error) { onResult(error); }
      if (stopped) break;
      await new Promise(resolve => {
        const wake = () => {
          clearTimeout(timer);
          process.removeListener('SIGINT', wake);
          process.removeListener('SIGTERM', wake);
          resolve();
        };
        const timer = setTimeout(wake, interval * 1000);
        process.once('SIGINT', wake);
        process.once('SIGTERM', wake);
      });
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
