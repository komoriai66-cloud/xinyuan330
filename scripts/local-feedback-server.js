// Dependency-free local preview for the feedback launcher.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const port = 8765;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm'
};
const hidden = new Set(['cloudflare', 'scripts', 'node_modules', 'online-data', 'tests', '.git']);

http.createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }
  let relative;
  try {
    relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch (_) {
    response.writeHead(400); response.end(); return;
  }
  const parts = (relative === '/' ? 'index.html' : relative).split(/[\\/]/).filter(Boolean);
  if (parts.some(part => part.startsWith('.')) || hidden.has(parts[0]) ||
      ['server.js', 'online-service.js', 'package.json', 'package-lock.json'].includes(parts[0])) {
    response.writeHead(403); response.end(); return;
  }
  const file = path.resolve(root, ...parts);
  if (!file.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403); response.end(); return;
  }
  fs.stat(file, (error, info) => {
    if (error || !info.isFile()) {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, {
      'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store'
    });
    if (request.method === 'HEAD') { response.end(); return; }
    fs.createReadStream(file).pipe(response);
  });
}).listen(port, '127.0.0.1');
