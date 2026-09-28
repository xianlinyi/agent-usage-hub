#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hasFlag, homeFrom, installCollector, installServer, loadCollector, loadServer,
} from '../src/config.js';
import { collectOnce, pushFile, watchCollector } from '../src/collector/index.js';
import { startServer } from '../src/server/http.js';

const help = `agent-usage — distributed token usage dashboard

Usage:
  agent-usage install server [--home DIR] [--host HOST] [--port PORT]
  agent-usage install collector [--home DIR] [--server URL] [--collector-id ID]
                                [--token-file PATH | --token-env NAME]
                                [--sources all|claude,codex,...]
  agent-usage server start [--home DIR]
  agent-usage collector once [--home DIR] [--full]
  agent-usage collector watch [--home DIR]
  agent-usage collector push FILE [--home DIR]
  agent-usage --version

The default collector reads local usage logs for all built-in sources directly.
Add local application plugins in collector.json. See README.md for details.
`;

async function main(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(help);
    return;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    const manifest = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    process.stdout.write(`${manifest.version}\n`);
    return;
  }
  const home = homeFrom(args);
  if (args[0] === 'install' && args[1] === 'server') {
    const result = await installServer(home, args);
    process.stdout.write(`Server configured: ${result.configFile}\nPush token file: ${result.pushTokenFile}\nAdmin token file: ${result.adminTokenFile}\nStart: agent-usage server start --home ${home}\n`);
    return;
  }
  if (args[0] === 'install' && args[1] === 'collector') {
    const result = await installCollector(home, args);
    process.stdout.write(`Collector configured: ${result.configFile}\nStart: agent-usage collector watch --home ${home}\n`);
    return;
  }
  if (args[0] === 'server' && args[1] === 'start') {
    const { config, secrets } = await loadServer(home);
    const { server, db } = await startServer(config, secrets);
    process.stdout.write(`Server listening at http://${config.host}:${config.port}\n`);
    const stop = () => { server.close(() => db.close()); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  if (args[0] === 'collector' && args[1] === 'once') {
    const result = await collectOnce(await loadCollector(home), { full: hasFlag(args, 'full') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (args[0] === 'collector' && args[1] === 'watch') {
    await watchCollector(await loadCollector(home), (error, result) => {
      if (error) process.stderr.write(`Collector error: ${error.message}\n`);
      else process.stdout.write(`${new Date().toISOString()} ${JSON.stringify(result)}\n`);
    });
    return;
  }
  if (args[0] === 'collector' && args[1] === 'push' && args[2]) {
    const result = await pushFile(await loadCollector(home), path.resolve(args[2]));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error(`Unknown command.\n\n${help}`);
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
