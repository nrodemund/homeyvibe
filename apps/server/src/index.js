import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8080);

createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'homeyvibe' }));
    return;
  }
  res.writeHead(404).end();
}).listen(port, () => console.log(`HomeyVibe server on :${port}`));
