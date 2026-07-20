"use strict";

const { fetch, Agent } = require("undici");

const SESSION_COOKIE = "openccu_loom_session";
const CSRF_COOKIE = "openccu_loom_csrf";
const CSRF_HEADER = "X-CSRF-Token";
const IDEMPOTENCY_HEADER = "Idempotency-Key";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// The daemon's default REST listen port (north.rest.listen = ":8119").
const DEFAULT_PORT = 8119;

// The REST/WS contract generation this package is developed against.
// The daemon reports its contract as `api_version` (semver) in
// GET /api/v1/info; a different MAJOR means breaking changes. The
// server config node performs the handshake and logs a warning when
// the remote daemon's major does not match.
const SUPPORTED_API_MAJOR = 2;

function buildBaseURL(server) {
  const scheme = server.tls ? "https" : "http";
  const port = server.port || (server.tls ? 443 : DEFAULT_PORT);
  return `${scheme}://${server.host}:${port}/api/v1`;
}

function buildWSURL(server) {
  const scheme = server.tls ? "wss" : "ws";
  const port = server.port || (server.tls ? 443 : DEFAULT_PORT);
  return `${scheme}://${server.host}:${port}/api/v1/events`;
}

function basicAuthHeader(creds) {
  if (!creds || !creds.username) return null;
  const raw = `${creds.username}:${creds.password || ""}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

function bearerAuthHeader(creds) {
  if (!creds || !creds.token) return null;
  return `Bearer ${creds.token}`;
}

function buildAuthHeader(server) {
  const auth = (server.authMethod || "basic").toLowerCase();
  const creds = server.credentials || {};
  if (auth === "bearer") {
    const h = bearerAuthHeader(creds);
    return h ? { Authorization: h } : {};
  }
  if (auth === "basic") {
    const h = basicAuthHeader(creds);
    return h ? { Authorization: h } : {};
  }
  return {};
}

// parseApiVersion splits the daemon's semver `api_version` ("2.27.0")
// into numbers; returns null when the string is not semver-shaped.
function parseApiVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ""));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

class OpenccuLoomClient {
  constructor(server) {
    this.server = server;
    this.cookies = new Map();
    this.baseURL = buildBaseURL(server);
    this.timeout = server.timeout || 10000;
    // Self-signed test setups: scope the relaxed verification to this
    // client's dispatcher instead of the process-wide TLS default.
    this.dispatcher =
      server.tls && server.insecureTLS
        ? new Agent({ connect: { rejectUnauthorized: false } })
        : undefined;
  }

  cookieHeader() {
    const parts = [];
    for (const [name, value] of this.cookies) parts.push(`${name}=${value}`);
    return parts.join("; ");
  }

  storeCookies(setCookieLines) {
    for (const line of setCookieLines || []) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || value === "deleted") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  buildHeaders(method, extra, hasBody) {
    const h = { Accept: "application/json" };
    if (hasBody) h["Content-Type"] = "application/json";
    const auth = (this.server.authMethod || "basic").toLowerCase();
    if (auth === "basic" || auth === "bearer") {
      Object.assign(h, buildAuthHeader(this.server));
    } else if (auth === "session") {
      const cookie = this.cookieHeader();
      if (cookie) h.Cookie = cookie;
      if (MUTATING.has(method.toUpperCase())) {
        const csrf = this.cookies.get(CSRF_COOKIE);
        if (csrf) h[CSRF_HEADER] = csrf;
      }
    }
    return Object.assign(h, extra || {});
  }

  buildURL(url, params) {
    let full = this.baseURL + url;
    if (params && typeof params === "object") {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v == null) continue;
        qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) full += (full.includes("?") ? "&" : "?") + s;
    }
    return full;
  }

  async rawRequest(cfg) {
    const method = (cfg.method || "GET").toUpperCase();
    const hasBody = cfg.data !== undefined;
    const headers = this.buildHeaders(method, cfg.headers, hasBody);
    const init = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeout),
    };
    if (this.dispatcher) init.dispatcher = this.dispatcher;
    if (hasBody) init.body = JSON.stringify(cfg.data);

    const res = await fetch(this.buildURL(cfg.url, cfg.params), init);
    this.storeCookies(res.headers.getSetCookie());

    const text = await res.text();
    let data = null;
    if (text !== "") {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("json")) {
        try {
          data = JSON.parse(text);
        } catch (_) {
          data = text;
        }
      } else {
        data = text;
      }
    }
    const headersObj = {};
    for (const [k, v] of res.headers) headersObj[k] = v;
    const out = { status: res.status, statusText: res.statusText, data, headers: headersObj };
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`HTTP ${res.status}`);
      err.response = out;
      throw err;
    }
    return out;
  }

  async login() {
    const creds = this.server.credentials || {};
    if (!creds.username) throw new Error("session auth: no username configured");
    const res = await this.rawRequest({
      method: "POST",
      url: "/auth/login",
      data: { username: creds.username, password: creds.password || "" },
    });
    if (!this.cookies.has(SESSION_COOKIE)) {
      throw new Error("session auth: no session cookie in /auth/login response");
    }
    return res.data;
  }

  async ensureSession() {
    if ((this.server.authMethod || "basic").toLowerCase() !== "session") return;
    if (!this.cookies.has(SESSION_COOKIE)) await this.login();
  }

  async request(cfg) {
    await this.ensureSession();
    try {
      return await this.rawRequest(cfg);
    } catch (err) {
      const status = err.response && err.response.status;
      const isSession = (this.server.authMethod || "basic").toLowerCase() === "session";
      if (isSession && (status === 401 || status === 403)) {
        this.cookies.clear();
        await this.login();
        return this.rawRequest(cfg);
      }
      throw err;
    }
  }

  get(url, opts) {
    return this.request({ ...(opts || {}), method: "GET", url });
  }
  post(url, data, opts) {
    return this.request({ ...(opts || {}), method: "POST", url, data });
  }
  put(url, data, opts) {
    return this.request({ ...(opts || {}), method: "PUT", url, data });
  }
  patch(url, data, opts) {
    return this.request({ ...(opts || {}), method: "PATCH", url, data });
  }
  delete(url, opts) {
    return this.request({ ...(opts || {}), method: "DELETE", url });
  }
}

function createClient(server) {
  return new OpenccuLoomClient(server);
}

function describeError(err) {
  if (err.response) {
    const body = err.response.data;
    let detail = "";
    if (typeof body === "object" && body) {
      detail = body.detail || body.title || "";
      // RFC 9457 problem details may carry field-level entries.
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        const fields = body.errors
          .map((e) => (e && e.field ? `${e.field}: ${e.message || e.detail || ""}` : String(e && (e.message || e.detail) ? e.message || e.detail : "")))
          .filter(Boolean)
          .join("; ");
        if (fields) detail = detail ? `${detail} (${fields})` : fields;
      }
      if (!detail) detail = JSON.stringify(body);
    } else {
      detail = String(body || "");
    }
    return `HTTP ${err.response.status} ${err.response.statusText || ""}`.trimEnd() + (detail ? `: ${detail}` : "");
  }
  if (err.name === "TimeoutError") return "request timed out";
  return err.message || String(err);
}

function mergeIdempotency(headers, msg, node) {
  const key = (msg && msg.idempotencyKey) || (node && node.idempotencyKey);
  if (!key) return headers;
  return Object.assign({}, headers || {}, { [IDEMPOTENCY_HEADER]: String(key) });
}

module.exports = {
  OpenccuLoomClient,
  createClient,
  buildWSURL,
  buildAuthHeader,
  describeError,
  mergeIdempotency,
  parseApiVersion,
  CSRF_HEADER,
  CSRF_COOKIE,
  SESSION_COOKIE,
  IDEMPOTENCY_HEADER,
  DEFAULT_PORT,
  SUPPORTED_API_MAJOR,
};
