import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = parseInt(process.env.PORT || 3001, 10);
const processes = new Map();

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (path === '/health' && req.method === 'GET') {
    const mem = process.memoryUsage();
    return json(res, 200, {
      ok: true,
      uptime: Math.floor(process.uptime()),
      running: processes.size,
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024)
      }
    });
  }

  if (path === '/spawn' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }
      const { command, args, cwd } = data;
      if (!command) return json(res, 400, { error: 'command required' });

      const id = crypto.randomUUID();
      let child;
      try {
        child = spawn(command, args || [], {
          cwd: cwd || '/data',
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }

      const entry = {
        id, child,
        running: true,
        exitCode: null,
        exitSignal: null,
        stderrListeners: [],
        exitListeners: []
      };

      child.stderr.on('data', chunk => {
        const copy = Buffer.from(chunk);
        for (const fn of entry.stderrListeners) {
          try { fn(copy); } catch {}
        }
      });

      child.on('exit', (code, signal) => {
        entry.running = false;
        entry.exitCode = code;
        entry.exitSignal = signal;
        for (const fn of entry.exitListeners) {
          try { fn(code, signal); } catch {}
        }
        setTimeout(() => processes.delete(id), 60000);
      });

      child.on('error', err => {
        entry.running = false;
        if (!entry.exitCode && !entry.exitSignal) {
          for (const fn of entry.exitListeners) {
            try { fn(null, null, err.message); } catch {}
          }
        }
      });

      processes.set(id, entry);
      return json(res, 200, { id, pid: child.pid });
    });
    return;
  }

  const stderrMatch = path.match(/^\/stderr\/(.+)$/);
  if (stderrMatch && req.method === 'GET') {
    const id = stderrMatch[1];
    const entry = processes.get(id);
    if (!entry) return json(res, 404, { error: 'not found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const onData = chunk => {
      res.write(`data: ${JSON.stringify(chunk.toString())}\n\n`);
    };
    const onExit = (code, signal, errorMsg) => {
      res.write(`event: exit\ndata: ${JSON.stringify({ code, signal, error: errorMsg || null })}\n\n`);
      res.end();
    };

    entry.stderrListeners.push(onData);
    entry.exitListeners.push(onExit);

    req.on('close', () => {
      const si = entry.stderrListeners.indexOf(onData);
      if (si >= 0) entry.stderrListeners.splice(si, 1);
      const ei = entry.exitListeners.indexOf(onExit);
      if (ei >= 0) entry.exitListeners.splice(ei, 1);
    });

    return;
  }

  const signalMatch = path.match(/^\/signal\/(.+)$/);
  if (signalMatch && req.method === 'POST') {
    const id = signalMatch[1];
    const entry = processes.get(id);
    if (!entry) return json(res, 404, { error: 'not found' });
    if (!entry.running) return json(res, 200, { ok: true, alreadyExited: true });

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch { data = {}; }
      const sig = data.signal || 'SIGTERM';
      try {
        entry.child.kill(sig);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  const statusMatch = path.match(/^\/status\/(.+)$/);
  if (statusMatch && req.method === 'GET') {
    const id = statusMatch[1];
    const entry = processes.get(id);
    if (!entry) return json(res, 404, { error: 'not found' });
    return json(res, 200, {
      running: entry.running,
      exitCode: entry.exitCode,
      exitSignal: entry.exitSignal
    });
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[StreamerServer] Listening on port ${PORT}`);
});
