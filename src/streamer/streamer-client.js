import http from 'node:http';
import { EventEmitter } from 'node:events';
import { RemoteProcess } from './remote-process.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('streamer-client');

export class StreamerClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this._parsed = new URL(this.baseUrl);
  }

  async _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: this._parsed.hostname,
        port: this._parsed.port || 3001,
        path,
        method,
        timeout: 10000,
        headers: {}
      };
      if (body) {
        const data = JSON.stringify(body);
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(data);
      }
      const req = http.request(opts, res => {
        let response = '';
        res.on('data', chunk => { response += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(response);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
            }
          } catch {
            reject(new Error(`Invalid JSON response: ${response.substring(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async health() {
    return this._request('GET', '/health');
  }

  async spawn(command, args = [], cwd = '/data') {
    const result = await this._request('POST', '/spawn', { command, args, cwd });
    return new RemoteProcess(this, result.id, result.pid);
  }

  async signal(id, signal) {
    return this._request('POST', `/signal/${encodeURIComponent(id)}`, { signal });
  }

  async status(id) {
    return this._request('GET', `/status/${encodeURIComponent(id)}`);
  }

  async waitForExit(id) {
    return new Promise((resolve, reject) => {
      const stream = this.streamStderr(id, {
        onData: () => {},
        onExit: (code, signal, error) => {
          resolve({ code, signal, error: error ? new Error(error) : null });
        },
        onError: reject
      });
      stream.on('error', reject);
    });
  }

  streamStderr(id, handlers) {
    const emitter = new EventEmitter();
    const url = `${this.baseUrl}/stderr/${encodeURIComponent(id)}`;
    const parsed = new URL(url);

    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 3001,
      path: parsed.pathname,
      method: 'GET',
      timeout: 0
    };

    const req = http.request(opts, res => {
      let currentEvent = null;
      let exited = false;
      res.on('data', chunk => {
        const text = chunk.toString();
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('event: ')) {
            currentEvent = trimmed.slice(7).trim();
          } else if (trimmed.startsWith('data: ')) {
            const payload = trimmed.slice(6);
            if (currentEvent === 'exit') {
              currentEvent = null;
              exited = true;
              try {
                const ev = JSON.parse(payload);
                if (handlers.onExit) handlers.onExit(ev.code, ev.signal, ev.error || null);
              } catch {
                if (handlers.onExit) handlers.onExit(null, null, null);
              }
            } else {
              try {
                const decoded = JSON.parse(payload);
                const buf = Buffer.from(decoded);
                if (handlers.onData) handlers.onData(buf);
              } catch {}
            }
          }
        }
      });
      res.on('end', () => {
        if (!exited && handlers.onExit) handlers.onExit(null, null, 'stream ended');
      });
      res.on('error', err => {
        if (handlers.onError) handlers.onError(err);
        emitter.emit('error', err);
      });
    });

    req.on('error', err => {
      if (handlers.onError) handlers.onError(err);
      emitter.emit('error', err);
    });
    req.end();

    emitter._req = req;
    return emitter;
  }
}
