import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

export async function* jsonLines(filename) {
  const lines = createInterface({ input: createReadStream(filename, { encoding: 'utf8' }), crlfDelay: Infinity });
  let number = 0;
  for await (const line of lines) {
    number++;
    if (!line.trim()) continue;
    try { yield { number, value: JSON.parse(line) }; }
    catch { /* Active logs may contain a final partial line. */ }
  }
}

export async function* jsonlFiles(root) {
  if (!root) return;
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      const filename = `${directory}/${entry.name}`;
      if (entry.isDirectory()) stack.push(filename);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        yield { filename, info: await stat(filename) };
      }
    }
  }
}
