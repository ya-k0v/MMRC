import { EventEmitter } from 'node:events';

export class RemoteProcess extends EventEmitter {
  constructor(client, id, pid) {
    super();
    this._client = client;
    this._remoteId = id;
    this._remotePid = pid;
    this._killed = false;
    this._exitCode = null;
    this._exitSignal = null;
    this._exited = false;
    this._stderr = new EventEmitter();
    this._error = null;
    this._stderrStream = null;

    this._connectStderr();
    this._waitExit();
  }

  get pid() { return this._remotePid; }
  get killed() { return this._killed; }
  get stderr() { return this._stderr; }

  kill(signal) {
    if (this._killed || this._exited) return;
    this._killed = true;
    this._client.signal(this._remoteId, signal || 'SIGTERM').catch(() => {});
  }

  removeAllListeners(event) {
    if (event) {
      super.removeAllListeners(event);
      if (event === 'exit' || event === 'close') {
        this._stderr.removeAllListeners('data');
      }
    } else {
      super.removeAllListeners();
      this._stderr.removeAllListeners('data');
    }
  }

  _connectStderr() {
    this._stderrStream = this._client.streamStderr(this._remoteId, {
      onData: chunk => {
        this._stderr.emit('data', chunk);
      },
      onExit: (code, signal, errorMsg) => {
        this._exited = true;
        this._exitCode = code;
        this._exitSignal = signal;
        if (errorMsg) {
          this._error = new Error(errorMsg);
          this.emit('error', this._error);
        }
        this.emit('exit', code, signal);
        this.emit('close', code, signal);
      },
      onError: err => {
        if (!this._exited) {
          this.emit('error', err);
        }
      }
    });
  }

  _waitExit() {
    this._client.waitForExit(this._remoteId).then(({ code, signal, error }) => {
      if (!this._exited) {
        this._exited = true;
        this._exitCode = code;
        this._exitSignal = signal;
        if (error) {
          this._error = error;
          this.emit('error', error);
        }
        this.emit('exit', code, signal);
        this.emit('close', code, signal);
      }
    }).catch(err => {
      if (!this._exited) {
        this.emit('error', err);
      }
    });
  }

  get exitCode() { return this._exitCode; }
  get signalCode() { return this._exitSignal; }
}
