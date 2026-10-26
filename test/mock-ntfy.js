'use strict';
// A tiny ntfy-compatible server for tests: POST /<topic>, GET /<t1,t2>/json?since=<unix|all>.

const http = require('http');
const crypto = require('crypto');

function createMockNtfy({ keepaliveMs = 200 } = {}) {
  const cache = [];      // { id, time, event, topic, message }
  const streams = new Set();
  let clock = null;      // optional fixed clock (unix seconds) for tests
  const now = () => clock != null ? clock : Math.floor(Date.now() / 1000);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'POST' && parts.length === 1) {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        const m = { id: crypto.randomBytes(6).toString('hex'), time: now(), event: 'message', topic: parts[0], message: body };
        cache.push(m);
        for (const s of streams) if (s.topics.includes(m.topic)) s.res.write(JSON.stringify(m) + '\n');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(m));
      });
      return;
    }
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'json') {
      const topics = parts[0].split(',');
      const sinceRaw = url.searchParams.get('since');
      const since = sinceRaw === 'all' ? 0 : sinceRaw ? Number(sinceRaw) : Infinity;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ id: 'open', time: now(), event: 'open', topic: parts[0] }) + '\n');
      for (const m of cache) if (topics.includes(m.topic) && m.time >= since) res.write(JSON.stringify(m) + '\n');
      const s = { topics, res };
      streams.add(s);
      const ka = setInterval(() => res.write(JSON.stringify({ id: 'ka', time: now(), event: 'keepalive', topic: parts[0] }) + '\n'), keepaliveMs);
      req.on('close', () => { clearInterval(ka); streams.delete(s); });
      return;
    }
    res.writeHead(404); res.end();
  });

  return {
    cache,
    get streamCount() { return streams.size; },
    setClock(t) { clock = t; },
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise(r => { for (const s of streams) s.res.destroy(); server.close(() => r()); })
  };
}

module.exports = { createMockNtfy };
