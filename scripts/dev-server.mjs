// Zero-dependency static server for SIGIL. The camera API needs a secure context: http://localhost is one.
//   node scripts/dev-server.mjs [port] [dir]   ->  http://localhost:5173
// Dev only (it lives in scripts/ and is .vercelignore'd so a host never mistakes it for a server entry).
// With [dir] it serves that folder as-is (e.g. `dist`, to check a production build); without, the repo root,
// with vendor/ aliased to node_modules.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.argv[3] ? resolve(process.argv[3]) : fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
// vendor/ is where the app (and dist/) find third-party code and the model; in dev it's served straight from
// their real homes so there is one URL scheme everywhere.
const VENDOR = process.argv[3] ? [] : [['/vendor/three/', 'node_modules/three/'], ['/vendor/mediapipe/', 'node_modules/@mediapipe/tasks-vision/'], ['/vendor/models/', 'models/']];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.task': 'application/octet-stream',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    for (const [from, to] of VENDOR) if (pathname.startsWith(from)) { pathname = '/' + to + pathname.slice(from.length); break; }
    let path = normalize(join(ROOT, pathname));
    if (!path.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}).listen(PORT, () => console.log(`SIGIL running at http://localhost:${PORT}`));
