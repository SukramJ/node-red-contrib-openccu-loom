"use strict";

const WebSocket = require("ws");
const { buildWSURL, buildAuthHeader, createClient, SESSION_COOKIE } = require("./client");

const hubs = new Map();

function hubKey(server) {
  return server && server.id ? server.id : `${server.host}:${server.port}:${server.authMethod || "basic"}`;
}

class WsHub {
  constructor(server) {
    this.server = server;
    this.ws = null;
    this.closed = false;
    this.connecting = false;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.lastSeq = 0;
    this.subscribers = new Set();
    this.statusListeners = new Set();
    this.subscriptions = new Map();
    this.pendingCalls = new Map();
    this.commandCounter = 0;
    this.sessionClient =
      (server.authMethod || "basic").toLowerCase() === "session"
        ? createClient(server)
        : null;
    this.refCount = 0;
  }

  addRef() {
    this.refCount += 1;
    if (this.refCount === 1 && !this.ws && !this.connecting) this.connect();
  }

  release() {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount === 0) this.shutdown();
  }

  shutdown() {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {
        /* swallow */
      }
    }
    this.ws = null;
    for (const [, pending] of this.pendingCalls) {
      try {
        pending.reject(new Error("ws hub shut down"));
      } catch (_) {
        /* swallow */
      }
    }
    this.pendingCalls.clear();
  }

  onEvent(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  onStatus(fn) {
    this.statusListeners.add(fn);
    fn(this.status());
    return () => this.statusListeners.delete(fn);
  }

  status() {
    if (this.closed) return "closed";
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return "open";
    if (this.connecting || (this.ws && this.ws.readyState === WebSocket.CONNECTING)) return "connecting";
    return "disconnected";
  }

  emitStatus() {
    const s = this.status();
    for (const fn of this.statusListeners) {
      try {
        fn(s);
      } catch (_) {
        /* swallow */
      }
    }
  }

  registerTopics(ownerId, topics) {
    this.subscriptions.set(ownerId, topics);
    this.sendSubscribeAll();
  }

  unregisterOwner(ownerId) {
    this.subscriptions.delete(ownerId);
    this.sendSubscribeAll();
  }

  sendSubscribeAll() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const all = new Set();
    for (const [, list] of this.subscriptions) for (const t of list) all.add(t);
    if (all.size === 0) return;
    const payload = { op: "subscribe", topics: Array.from(all) };
    if (this.lastSeq > 0) payload.since = this.lastSeq;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (_) {
      /* swallow */
    }
  }

  sendSubscribe(topics) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ op: "subscribe", topics }));
    } catch (_) {
      /* swallow */
    }
  }

  sendUnsubscribe(topics) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ op: "unsubscribe", topics }));
    } catch (_) {
      /* swallow */
    }
  }

  reauth(token) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ op: "reauth", token }));
    } catch (_) {
      /* swallow */
    }
  }

  call(command, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("ws hub not connected"));
        return;
      }
      const id = `n${++this.commandCounter}-${Date.now().toString(36)}`;
      const timeout = setTimeout(() => {
        if (this.pendingCalls.has(id)) {
          this.pendingCalls.delete(id);
          reject(new Error(`ws call timeout (${command})`));
        }
      }, timeoutMs || 15000);
      this.pendingCalls.set(id, {
        resolve: (val) => {
          clearTimeout(timeout);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      try {
        this.ws.send(JSON.stringify({ op: "call", id, command, args: args || {} }));
      } catch (err) {
        this.pendingCalls.delete(id);
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  async buildHeaders() {
    const headers = {};
    const auth = (this.server.authMethod || "basic").toLowerCase();
    if (auth === "session") {
      if (!this.sessionClient.cookies.has(SESSION_COOKIE)) {
        await this.sessionClient.login();
      }
      const cookie = this.sessionClient.cookieHeader();
      if (cookie) headers.Cookie = cookie;
    } else {
      Object.assign(headers, buildAuthHeader(this.server));
    }
    return headers;
  }

  scheduleReconnect() {
    if (this.closed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  async connect() {
    if (this.closed || this.connecting) return;
    this.connecting = true;
    this.emitStatus();
    let headers;
    try {
      headers = await this.buildHeaders();
    } catch (err) {
      this.connecting = false;
      this.notifyError(`auth preparation failed: ${err.message}`);
      this.scheduleReconnect();
      return;
    }
    const url = buildWSURL(this.server);
    const opts = {
      headers,
      rejectUnauthorized: !(this.server.tls && this.server.insecureTLS),
      handshakeTimeout: 10000,
    };
    let ws;
    try {
      ws = new WebSocket(url, opts);
    } catch (err) {
      this.connecting = false;
      this.notifyError(`ws connect failed: ${err.message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode;
      if (status === 401 || status === 403) {
        this.closed = true;
        this.notifyError(`ws authentication failed (HTTP ${status}). Reconnect halted.`);
        try {
          ws.terminate();
        } catch (_) {
          /* swallow */
        }
        this.emitStatus();
      }
    });

    ws.on("open", () => {
      this.connecting = false;
      this.reconnectDelay = 1000;
      this.emitStatus();
      this.sendSubscribeAll();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.ping();
          } catch (_) {
            /* swallow */
          }
        }
      }, 25000);
    });

    ws.on("message", (data) => {
      let payload;
      try {
        payload = JSON.parse(data.toString());
      } catch (_) {
        return;
      }
      if (!payload || typeof payload !== "object") return;
      this.handleFrame(payload);
    });

    ws.on("close", (code) => {
      this.connecting = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      if (this.sessionClient && (code === 1008 || code === 4401 || code === 4403)) {
        this.sessionClient.cookies.clear();
      }
      this.emitStatus();
      if (!this.closed) this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.notifyError(`ws error: ${err.message}`);
    });
  }

  handleFrame(frame) {
    if (frame.op === "ping") {
      try {
        this.ws && this.ws.send(JSON.stringify({ op: "pong" }));
      } catch (_) {
        /* swallow */
      }
      return;
    }
    if (frame.op === "pong") return;
    if (frame.op === "replay_done") {
      this.notifyControl({ op: "replay_done", seq: frame.seq });
      return;
    }
    if (frame.op === "replay_lost") {
      this.notifyControl({ op: "replay_lost", oldest_seq: frame.oldest_seq });
      this.lastSeq = 0;
      return;
    }
    if (frame.op === "result") {
      const pending = this.pendingCalls.get(frame.id);
      if (!pending) return;
      this.pendingCalls.delete(frame.id);
      if (frame.error) pending.reject(Object.assign(new Error(frame.error.message || "ws command error"), { details: frame.error }));
      else pending.resolve(frame.data);
      return;
    }
    if (typeof frame.seq === "number" && frame.seq > this.lastSeq) {
      this.lastSeq = frame.seq;
    }
    for (const fn of this.subscribers) {
      try {
        fn(frame);
      } catch (_) {
        /* swallow */
      }
    }
  }

  notifyError(text) {
    for (const fn of this.statusListeners) {
      try {
        fn({ error: text });
      } catch (_) {
        /* swallow */
      }
    }
  }

  notifyControl(frame) {
    for (const fn of this.subscribers) {
      try {
        fn({ __control: true, ...frame });
      } catch (_) {
        /* swallow */
      }
    }
  }
}

function getHub(server) {
  const key = hubKey(server);
  let hub = hubs.get(key);
  if (!hub) {
    hub = new WsHub(server);
    hubs.set(key, hub);
  }
  return hub;
}

function releaseHub(server) {
  const key = hubKey(server);
  const hub = hubs.get(key);
  if (!hub) return;
  hub.release();
  if (hub.refCount === 0) hubs.delete(key);
}

module.exports = { getHub, releaseHub };
