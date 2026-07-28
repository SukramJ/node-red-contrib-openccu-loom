"use strict";

const assert = require("assert");
const http = require("http");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const { SUPPORTED_API_MAJOR } = require("../lib/client");

helper.init(require.resolve("node-red"));

function startBackend(info) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === "/api/v1/info" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(info));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ title: "Not Found" }));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// A server that is guaranteed unreachable: listen once to claim a free
// ephemeral port, then close it immediately so nothing answers there.
function unreachablePort() {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => res.end());
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function flow(port) {
  return [
    {
      id: "s1",
      type: "openccu-loom-server",
      name: "test",
      host: "127.0.0.1",
      port,
      tls: false,
      authMethod: "basic",
      timeout: 1000,
    },
  ];
}

function loadFlow(testFlow) {
  return new Promise((resolve) => helper.load(serverNode, testFlow, resolve));
}

describe("openccu-loom-server handshake", function () {
  let backend;

  afterEach(function (done) {
    helper.unload().then(() => {
      if (!backend) return done();
      const closing = backend;
      backend = null;
      closing.close(() => done());
    });
  });

  it("marks the API supported and resolves hasCapability(true) for a matching major + known capability", async function () {
    backend = await startBackend({
      version: "0.44.0",
      commit: "abc1234",
      build_date: "2026-01-01",
      addon_build: false,
      uptime: "1h",
      started_at: "2026-01-01T00:00:00Z",
      api_version: "3.1.0",
      schema_digest: "sha256:deadbeef",
      capabilities: ["rest.v1", "alarm.v1"],
    });
    const port = backend.address().port;
    await loadFlow(flow(port));

    const n1 = helper.getNode("s1");
    const warnCalls = [];
    n1.warn = (text) => warnCalls.push(text);

    await n1.refreshInfo(true);
    assert.strictEqual(n1.api.version, "3.1.0");
    assert.strictEqual(n1.api.major, SUPPORTED_API_MAJOR);
    assert.strictEqual(n1.api.supported, true);
    assert.deepStrictEqual(n1.api.capabilities, ["rest.v1", "alarm.v1"]);
    assert.strictEqual(n1.api.error, null);
    assert.strictEqual(warnCalls.length, 0, "a supported major must not warn");

    assert.strictEqual(await n1.hasCapability("alarm.v1"), true);
    assert.strictEqual(await n1.hasCapability("mcp.v1"), false);
  });

  it("marks the API unsupported and warns once for a mismatched major", async function () {
    backend = await startBackend({
      version: "0.44.0",
      commit: "abc1234",
      build_date: "2026-01-01",
      addon_build: false,
      uptime: "1h",
      started_at: "2026-01-01T00:00:00Z",
      api_version: "4.0.0",
      schema_digest: "sha256:deadbeef",
      capabilities: ["rest.v1"],
    });
    const port = backend.address().port;
    await loadFlow(flow(port));

    const n1 = helper.getNode("s1");
    const warnCalls = [];
    n1.warn = (text) => warnCalls.push(text);

    await n1.refreshInfo(true);
    assert.strictEqual(n1.api.version, "4.0.0");
    assert.strictEqual(n1.api.major, 4);
    assert.strictEqual(n1.api.supported, false);
    assert.strictEqual(warnCalls.length, 1, "a mismatched major must warn exactly once");
    assert.ok(/API 4\.0\.0/.test(warnCalls[0]), `unexpected warning: ${warnCalls[0]}`);

    // A second handshake must not warn again (the `warned` guard is sticky).
    await n1.refreshInfo(true);
    assert.strictEqual(warnCalls.length, 1);
  });

  it("resolves hasCapability(false) and sets api.error when the daemon is unreachable", async function () {
    const port = await unreachablePort();
    await loadFlow(flow(port));

    const n1 = helper.getNode("s1");
    await n1.refreshInfo(true);
    assert.ok(n1.api.error, "expected api.error to be set");
    assert.strictEqual(n1.api.supported, null);

    assert.strictEqual(await n1.hasCapability("alarm.v1"), false);
  });
});
