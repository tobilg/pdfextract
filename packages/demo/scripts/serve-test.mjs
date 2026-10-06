import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve('dist');
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
};
// Serve only the built artifact below a non-root base, with no SPA fallback hiding missing assets.
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:4177');
    if (!url.pathname.startsWith('/demo/')) throw new Error('Outside demo');
    let path = resolve(root, decodeURIComponent(url.pathname.slice('/demo/'.length)));
    if (path !== root && !path.startsWith(root + sep)) throw new Error('Outside output');
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    createReadStream(path)
      .on('error', () => response.destroy())
      .pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
});
server.listen(4177, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.closeAllConnections();
    server.close();
  });
