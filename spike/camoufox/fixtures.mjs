/**
 * Local HTTP fixture server for the Camoufox spike:
 * upload endpoint, download endpoint, cookie endpoint, storage endpoint.
 */
import http from 'node:http';

export function createFixtureServer() {
  const uploads = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body>
        <h1 id="title">camoufox spike fixture</h1>
        <input id="file" type="file">
        <a id="dl" href="/download" download>download</a>
        <a id="storage-link" href="/storage">storage</a>
        <p id="status">idle</p>
        <script>
          document.getElementById('file').addEventListener('change', (e) => {
            document.getElementById('status').textContent = 'picked:' + e.target.files[0].name;
          });
          setTimeout(() => { document.getElementById('status').textContent = 'ready'; }, 300);
        </script>
      </body></html>`);
      return;
    }
    if (url.pathname === '/upload' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        uploads.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, bytes: body.length, content: body }));
      });
      return;
    }
    if (url.pathname === '/download') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="spike-download.txt"',
      });
      res.end('camoufox-download-payload');
      return;
    }
    if (url.pathname === '/setcookie') {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Set-Cookie': 'spike_session=abc123; Path=/; Max-Age=3600',
      });
      res.end('cookie-set');
      return;
    }
    if (url.pathname === '/storage') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('storage');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return { server, uploads };
}

export function listen(server, port = 0) {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}
