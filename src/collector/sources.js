import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { collectCodexFile } from './adapters/codex.js';
import { collectClaudeFile } from './adapters/claude.js';
import { collectNativeJsonFile } from './adapters/native-json.js';
import { collectNativeSqliteFile } from './adapters/native-sqlite.js';
import { collectAntigravityFile } from './adapters/native-antigravity.js';

export const builtinSources = [
  'claude', 'codex', 'opencode', 'amp', 'droid', 'codebuff', 'hermes', 'pi', 'goose',
  'kilo', 'copilot', 'gemini', 'antigravity', 'kimi', 'qwen', 'openclaw', 'grok', 'zcode',
];

const home = homedir();
const root = value => path.join(home, value);
const configured = (key, defaults) => {
  const env = process.env[key];
  return env ? env.split(',').map(value => value.trim()).filter(Boolean).map(value => path.resolve(value)) : defaults;
};
const codexHome = () => process.env.CODEX_HOME || root('.codex');
const sourceRoots = {
  claude: () => configured('CLAUDE_CONFIG_DIR', [root('.claude'), root('.config/claude')]).map(value => value.endsWith('projects') ? value : path.join(value, 'projects')),
  codex: () => [path.join(codexHome(), 'sessions'), path.join(codexHome(), 'archived_sessions')],
  opencode: () => configured('OPENCODE_DATA_DIR', [path.join(process.env.XDG_DATA_HOME || root('.local/share'), 'opencode')]),
  amp: () => configured('AMP_DATA_DIR', [root('.local/share/amp')]),
  droid: () => configured('DROID_SESSIONS_DIR', [root('.factory/sessions')]),
  codebuff: () => configured('CODEBUFF_DATA_DIR', ['manicode', 'manicode-dev', 'manicode-staging'].map(value => root(`.config/${value}`))),
  hermes: () => configured('HERMES_HOME', [root('.hermes')]),
  pi: () => configured('PI_AGENT_DIR', [root('.pi/agent/sessions')]),
  goose: () => process.env.GOOSE_PATH_ROOT ? [path.join(process.env.GOOSE_PATH_ROOT, 'data/sessions')]
    : [root('.local/share/goose/sessions'), root('Library/Application Support/goose/sessions'), root('.local/share/Block/goose/sessions')],
  kilo: () => configured('KILO_DATA_DIR', [root('.local/share/kilo')]),
  copilot: () => configured('COPILOT_HOME', [root('.copilot')]),
  gemini: () => configured('GEMINI_DATA_DIR', [root('.gemini/tmp')]),
  antigravity: () => configured('ANTIGRAVITY_DATA_DIR', [
    root('.gemini/antigravity'), root('.gemini/antigravity-cli'), root('.gemini/antigravity-ide'),
    root('.gemini/antigravity-backup'), root('.config/antigravity'),
  ]),
  kimi: () => configured('KIMI_DATA_DIR', [root('.kimi'), root('.kimi-code')]),
  qwen: () => configured('QWEN_DATA_DIR', [root('.qwen')]),
  openclaw: () => configured('OPENCLAW_DIR', [root('.openclaw'), root('.clawdbot'), root('.moltbot'), root('.moldbot')]),
  grok: () => configured('GROK_HOME', [root('.grok')]),
  zcode: () => configured('ZCODE_HOME', [root('.zcode')]),
};

const match = {
  claude: filename => filename.endsWith('.jsonl'),
  codex: filename => filename.endsWith('.jsonl'),
  opencode: filename => /(?:^|\/)(?:opencode(?:-[^/]*)?\.db|storage\/message\/[^/]+\/[^/]+\.json)$/.test(filename),
  amp: filename => /\/threads\/T-[^/]+\.json$/.test(filename),
  droid: filename => filename.endsWith('.settings.json'),
  codebuff: filename => filename.endsWith('/chat-messages.json'),
  hermes: filename => filename.endsWith('/state.db'),
  pi: filename => filename.endsWith('.jsonl') && !filename.includes('/subagent-artifacts/'),
  goose: filename => filename.endsWith('/sessions.db'),
  kilo: filename => filename.endsWith('/kilo.db'),
  copilot: filename => filename.endsWith('.jsonl') && (filename.includes('/otel/') || filename.endsWith('/events.jsonl')),
  gemini: filename => /\.jsonl?$/.test(filename),
  antigravity: filename => filename.endsWith('.db'),
  kimi: filename => filename.endsWith('/wire.jsonl') && filename.includes('/sessions/'),
  qwen: filename => filename.endsWith('.jsonl') && (filename.includes('/projects/') || filename.includes('/chats/')),
  openclaw: filename => /\.jsonl(?:\.(?:deleted|reset)\..+)?$/.test(filename) || filename.endsWith('/openclaw-agent.sqlite'),
  grok: filename => filename.endsWith('/updates.jsonl') && filename.includes('/sessions/'),
  zcode: filename => filename.endsWith('/cli/db/db.sqlite'),
};

export async function* sourceFiles(source, paths) {
  if (!builtinSources.includes(source)) throw new Error(`Unknown built-in source: ${source}`);
  const override = paths?.[source];
  const roots = override ? (Array.isArray(override) ? override : [override]) : sourceRoots[source]();
  const seen = new Set();
  const seenCodexRelative = new Set();
  if (source === 'copilot' && process.env.COPILOT_OTEL_FILE_EXPORTER_PATH) {
    const filename = path.resolve(process.env.COPILOT_OTEL_FILE_EXPORTER_PATH);
    try {
      const info = await stat(filename);
      if (info.isFile() && filename.endsWith('.jsonl')) {
        seen.add(filename);
        yield { filename, info };
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const directory of roots) {
    const stack = [directory];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try { entries = await readdir(current, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
      for (const entry of entries) {
        const filename = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(filename);
        else if (entry.isFile() && match[source](filename) && !seen.has(filename)) {
          if (source === 'codex') {
            const relative = path.relative(directory, filename);
            if (seenCodexRelative.has(relative)) continue;
            seenCodexRelative.add(relative);
          }
          seen.add(filename);
          yield { filename, info: await stat(filename) };
        }
      }
    }
  }
}

export async function* collectSourceFile(source, filename) {
  if (source === 'codex') { yield* collectCodexFile(filename); return; }
  if (source === 'claude') { yield* collectClaudeFile(filename); return; }
  const items = source === 'antigravity' ? await collectAntigravityFile(filename)
    : /\.(?:db|sqlite)$/.test(filename) ? collectNativeSqliteFile(source, filename)
      : await collectNativeJsonFile(source, filename);
  yield* items;
}
