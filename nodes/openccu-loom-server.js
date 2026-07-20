"use strict";

const { createClient, describeError, parseApiVersion, SUPPORTED_API_MAJOR, DEFAULT_PORT } = require("../lib/client");

// How long a successful handshake result is trusted before /info is
// fetched again on demand (capability checks, redeploys).
const INFO_TTL_MS = 60000;

module.exports = function (RED) {
  function OpenccuLoomServerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    this.host = config.host || "127.0.0.1";
    this.port = parseInt(config.port, 10) || DEFAULT_PORT;
    this.tls = !!config.tls;
    this.insecureTLS = !!config.insecureTLS;
    this.authMethod = config.authMethod || "basic";
    this.timeout = parseInt(config.timeout, 10) || 10000;

    // API handshake state: filled from GET /api/v1/info. `supported`
    // stays null until the first handshake succeeds, so nodes can
    // distinguish "unknown (daemon unreachable)" from "checked".
    this.api = {
      version: null,
      major: null,
      capabilities: [],
      supported: null,
      checkedAt: 0,
      error: null,
    };
    let inflight = null;
    let warned = false;

    this.refreshInfo = (force) => {
      const fresh = Date.now() - node.api.checkedAt < INFO_TTL_MS;
      if (!force && fresh && node.api.version) return Promise.resolve(node.api);
      if (inflight) return inflight;
      const client = createClient(node);
      inflight = client
        .get("/info")
        .then((res) => {
          const info = res.data || {};
          const parsed = parseApiVersion(info.api_version);
          node.api.version = info.api_version || null;
          node.api.major = parsed ? parsed.major : null;
          node.api.capabilities = Array.isArray(info.capabilities) ? info.capabilities : [];
          node.api.supported = parsed ? parsed.major === SUPPORTED_API_MAJOR : false;
          node.api.checkedAt = Date.now();
          node.api.error = null;
          if (!node.api.supported && !warned) {
            warned = true;
            node.warn(
              `openccu-loom at ${node.host}:${node.port} reports API ${node.api.version}; ` +
                `this package supports major ${SUPPORTED_API_MAJOR}.x — nodes may misbehave. ` +
                `Update node-red-contrib-openccu-loom or the daemon.`
            );
          }
          return node.api;
        })
        .catch((err) => {
          node.api.error = describeError(err);
          node.api.checkedAt = Date.now();
          node.debug(`API handshake failed: ${node.api.error}`);
          return node.api;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    };

    // hasCapability resolves against the daemon's /info capability
    // tokens (e.g. "alarm.v1"); unreachable daemons yield false with
    // api.error set, so callers can report a useful status.
    this.hasCapability = async (token) => {
      const api = await node.refreshInfo(false);
      return api.capabilities.includes(token);
    };

    // Handshake at deploy — fire and forget; failures are re-tried on
    // the next on-demand refreshInfo call.
    setImmediate(() => {
      node.refreshInfo(true).catch(() => {});
    });
  }

  RED.nodes.registerType("openccu-loom-server", OpenccuLoomServerNode, {
    credentials: {
      username: { type: "text" },
      password: { type: "password" },
      token: { type: "password" },
    },
  });

  RED.httpAdmin.post(
    "/openccu-loom/test-connection",
    RED.auth.needsPermission("openccu-loom.write"),
    async (req, res) => {
      const body = req.body || {};
      const id = body.id;
      const probe = {
        host: body.host || "127.0.0.1",
        port: parseInt(body.port, 10) || DEFAULT_PORT,
        tls: !!body.tls,
        insecureTLS: !!body.insecureTLS,
        authMethod: body.authMethod || "basic",
        timeout: parseInt(body.timeout, 10) || 10000,
        credentials: {
          username: body.username || "",
          password: body.password || "",
          token: body.token || "",
        },
      };
      if (id) {
        const existing = RED.nodes.getCredentials(id) || {};
        if (!probe.credentials.username) probe.credentials.username = existing.username || "";
        if (!probe.credentials.password) probe.credentials.password = existing.password || "";
        if (!probe.credentials.token) probe.credentials.token = existing.token || "";
      }
      try {
        const client = createClient(probe);
        const r = await client.get("/info");
        const parsed = parseApiVersion(r.data && r.data.api_version);
        res.json({
          ok: true,
          status: r.status,
          info: r.data,
          apiVersion: (r.data && r.data.api_version) || null,
          capabilities: (r.data && r.data.capabilities) || [],
          supported: parsed ? parsed.major === SUPPORTED_API_MAJOR : false,
          supportedMajor: SUPPORTED_API_MAJOR,
        });
      } catch (err) {
        res.status(200).json({ ok: false, error: describeError(err) });
      }
    }
  );
};
