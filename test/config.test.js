import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { builtinSources } from '../src/collector/sources.js';
import { installCollector, installServer, loadCollector, loadServer, resolvePushToken } from '../src/config.js';

test('role installs keep push and admin credentials in separate private files', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'usage-install-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const server = await installServer(home, ['--port', '43210']);
  const secrets = await loadServer(home);
  assert.ok(secrets.secrets.pushToken);
  assert.ok(secrets.secrets.adminToken);
  assert.notEqual(secrets.secrets.pushToken, secrets.secrets.adminToken);
  assert.equal((await stat(server.pushTokenFile)).mode & 0o777, 0o600);
  assert.equal((await stat(server.adminTokenFile)).mode & 0o777, 0o600);
  const collector = await installCollector(home, ['--server', 'http://127.0.0.1:43210', '--token-file', server.pushTokenFile]);
  assert.deepEqual(collector.config.sources, builtinSources);
  assert.equal(await resolvePushToken(collector.config), secrets.secrets.pushToken);
});

test('legacy ccusage collector config reads through native sources', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'usage-migration-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, 'collector.json'), JSON.stringify({
    sources: ['ccusage'], paths: { codex: path.join(homedir(), '.codex', 'sessions') },
  }));
  const config = await loadCollector(home);
  assert.deepEqual(config.sources, builtinSources);
  assert.equal(config.paths.codex, undefined);
});
