import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const build = path.join(import.meta.dirname, '../build');
http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/v1/press') { res.setHeader('content-type', 'text/plain'); return res.end('pressed'); }
  if (url.startsWith('/api/')) { res.statusCode = 404; res.setHeader('content-type', 'application/json'); return res.end('{}'); }
  if (url === '/app.js' || url === '/settings.js') { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync(build + url)); }
  res.setHeader('content-type', 'text/html');
  res.end(fs.readFileSync(build + '/index.html'));
}).listen(4598, '127.0.0.1');
