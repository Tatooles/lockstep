// Reference point for the GBA spike: serves an mGBA Wasm build next to our ROMs
// with the cross-origin isolation headers its threaded runtime needs.
//   npm pack @thenick775/mgba-wasm && tar xzf *.tgz   (anywhere outside the repo)
//   node tools/serve-mgba-bench.ts <path to package/dist> [port]
// Then open http://<host>:<port>/?rom=emerald&steps=... (see tools/mgba-bench/index.html).
// mGBA is MPL-2.0; it is not vendored into this repo.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize } from 'node:path';

const root = join(import.meta.dirname, '..');
const dist = process.argv[2];
const port = Number(process.argv[3] ?? 5174);
if (!dist || !existsSync(join(dist, 'mgba.js'))) {
  console.error('usage: node tools/serve-mgba-bench.ts <mgba-wasm package/dist> [port]');
  process.exit(1);
}
const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.gba': 'application/octet-stream',
  '.sav': 'application/octet-stream',
};

function resolve(url: string): string | null {
  const path = normalize(decodeURIComponent(url.split('?')[0]));
  if (path === '/' || path === '/index.html') return join(root, 'tools', 'mgba-bench', 'index.html');
  if (path.startsWith('/mgba/')) return join(dist, path.slice('/mgba/'.length));
  if (path.startsWith('/roms/')) return join(root, 'roms', path.slice('/roms/'.length));
  return null;
}

createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.method === 'POST' && req.url?.startsWith('/__shot?name=')) {
    // Screenshots for diffing renderers: tools/out/mgba-<name>.png
    const name = (req.url.split('=')[1] ?? 'shot').replace(/[^\w-]/g, '');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      mkdirSync(join(root, 'tools', 'out'), { recursive: true });
      writeFileSync(join(root, 'tools', 'out', `mgba-${name}.png`), Buffer.concat(chunks));
      res.end('ok');
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/__bench-result') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      mkdirSync(join(root, 'tools', 'out'), { recursive: true });
      appendFileSync(join(root, 'tools', 'out', 'bench-results.jsonl'), body.replace(/\n/g, ' ') + '\n');
      console.log(`[mgba bench] ${body}`);
      res.end('ok');
    });
    return;
  }
  const file = resolve(req.url ?? '/');
  if (!file || !existsSync(file)) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
  res.end(readFileSync(file));
}).listen(port, '0.0.0.0', () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  console.log(`mGBA bench on http://localhost:${port}/ and http://${lan}:${port}/`);
});
