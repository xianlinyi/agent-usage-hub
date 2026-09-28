import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const packageFile = path.resolve('agent-usage-hub-0.1.0.tgz');
const directory = await mkdtemp(path.join(tmpdir(), 'agent-usage-package-'));
const home = path.join(directory, 'home');
const source = path.join(directory, 'qwen', 'chats', 'session.jsonl');
const args = (...extra) => ['--yes', '--package', packageFile, 'agent-usage', ...extra];
let server;

async function run(...extra) {
  const child = spawn('npx', args(...extra), { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => output.push(chunk));
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 0, Buffer.concat(output).toString());
  return Buffer.concat(output).toString();
}

try {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  await run('install', 'server', '--home', home, '--port', String(port));
  server = spawn('npx', args('server', 'start', '--home', home), { cwd: process.cwd(), stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { healthy = (await fetch(`${url}/api/v1/health`)).ok; } catch { /* starting */ }
    if (healthy) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(healthy, 'packaged server did not become healthy');
  await run('install', 'collector', '--home', home, '--server', url,
    '--token-file', path.join(home, 'push-token'), '--sources', 'qwen');
  const configFile = path.join(home, 'collector.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.paths.qwen = path.join(directory, 'qwen');
  await writeFile(configFile, JSON.stringify(config));
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, `${JSON.stringify({ type: 'assistant', timestamp: '2026-09-28T10:00:00Z',
    model: 'qwen-smoke', usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 } })}\n`);
  const result = JSON.parse(await run('collector', 'once', '--home', home));
  assert.equal(result.inserted, 1);
  const adminToken = (await readFile(path.join(home, 'admin-token'), 'utf8')).trim();
  const response = await fetch(`${url}/api/v1/summary`, { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.equal(summary.totalTokens, 15);
  process.stdout.write('Packaged npx server + collector + authenticated summary: passed\n');
} finally {
  if (server) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true });
}
