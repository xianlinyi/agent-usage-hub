import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { builtinSources } from './collector/sources.js';

export const defaultHome = path.join(homedir(), '.agent-usage-hub');

export function option(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`--${name} requires a value`);
  }
  return args[index + 1];
}

export function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

export function homeFrom(args) {
  return path.resolve(option(args, 'home', process.env.AGENT_USAGE_HOME || defaultHome));
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writePrivateJson(file, value, { overwrite = false } = {}) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: overwrite ? 'w' : 'wx',
  });
}

export async function installServer(home, args) {
  const configFile = path.join(home, 'server.json');
  const pushTokenFile = path.join(home, 'push-token');
  const adminTokenFile = path.join(home, 'admin-token');
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    await stat(configFile);
    throw new Error(`Server is already configured at ${configFile}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const file of [pushTokenFile, adminTokenFile]) {
    try {
      await stat(file);
      throw new Error(`Token file already exists at ${file}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const port = Number(option(args, 'port', '4318'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
  const host = option(args, 'host', '127.0.0.1');
  const config = { host, port, database: path.join(home, 'usage.sqlite'), pushTokenFile, adminTokenFile };
  const secrets = {
    pushToken: randomBytes(32).toString('hex'),
    adminToken: randomBytes(32).toString('hex'),
  };
  await writeFile(pushTokenFile, `${secrets.pushToken}\n`, { mode: 0o600, flag: 'wx' });
  await writeFile(adminTokenFile, `${secrets.adminToken}\n`, { mode: 0o600, flag: 'wx' });
  await writePrivateJson(configFile, config);
  return { configFile, pushTokenFile, adminTokenFile, config };
}

export async function installCollector(home, args) {
  const configFile = path.join(home, 'collector.json');
  const serverUrl = option(args, 'server', 'http://127.0.0.1:4318');
  const url = new URL(serverUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Server URL must use HTTP or HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new Error('Server URL cannot contain credentials, query, or fragment');
  const collectorId = option(args, 'collector-id', hostname());
  const tokenFileOption = option(args, 'token-file', null);
  const tokenFile = tokenFileOption ? path.resolve(tokenFileOption) : null;
  const tokenEnv = option(args, 'token-env', 'AGENT_USAGE_PUSH_TOKEN');
  const requested = option(args, 'sources', 'all').split(',').map(s => s.trim()).filter(Boolean);
  const sources = requested.includes('all') ? builtinSources : [...new Set(requested)];
  if (sources.some(s => !builtinSources.includes(s))) throw new Error(`Built-in sources: ${builtinSources.join(', ')}`);
  const config = {
    serverUrl: url.origin,
    collectorId,
    tokenFile,
    tokenEnv,
    intervalSeconds: 300,
    sources,
    plugins: [],
    extensions: {},
    paths: {},
    stateFile: path.join(home, 'collector-state.json'),
  };
  await writePrivateJson(configFile, config);
  return { configFile, config };
}

export async function loadServer(home) {
  const config = await readJson(path.join(home, 'server.json'));
  const secrets = config.secrets ? await readJson(config.secrets) : {
    pushToken: (await readFile(config.pushTokenFile, 'utf8')).trim(),
    adminToken: (await readFile(config.adminTokenFile, 'utf8')).trim(),
  };
  return { config, secrets };
}

export async function loadCollector(home) {
  const config = await readJson(path.join(home, 'collector.json'));
  if (config.sources?.includes('ccusage')) {
    config.sources = [...new Set([...builtinSources, ...config.sources.filter(source => source !== 'ccusage')])];
    const oldCodex = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'sessions') : path.join(homedir(), '.codex', 'sessions');
    if (config.paths?.codex === oldCodex) delete config.paths.codex;
    const oldClaude = [path.join(homedir(), '.claude', 'projects'), path.join(homedir(), '.config', 'claude', 'projects')];
    if (JSON.stringify(config.paths?.claude) === JSON.stringify(oldClaude)) delete config.paths.claude;
  }
  return config;
}

export async function resolvePushToken(config) {
  if (config.tokenFile) {
    const raw = (await readFile(config.tokenFile, 'utf8')).trim();
    if (raw.startsWith('{')) return JSON.parse(raw).pushToken;
    return raw;
  }
  return process.env[config.tokenEnv || 'AGENT_USAGE_PUSH_TOKEN'];
}
