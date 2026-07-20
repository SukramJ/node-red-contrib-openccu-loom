"use strict";

const assert = require("assert");
const http = require("http");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const paramsetNode = require("../nodes/openccu-loom-paramset.js");

helper.init(require.resolve("node-red"));

// Address "BROKEN" is a sentinel that makes the backend respond 500 so the
// error path can be exercised on the same server as the happy paths.
function startBackend() {
  return new Promise((resolve) => {
    const requests = [];
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let body = null;
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch (_) {
            body = raw;
          }
        }
        if (req.url !== "/api/v1/info") requests.push({ method: req.method, url: req.url, body });

        const m = req.url.match(/^\/api\/v1\/devices\/([^/]+)\/paramsets\/([^/]+)$/);
        if (m) {
          const addr = decodeURIComponent(m[1]);
          if (addr === "BROKEN") {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ title: "Internal Server Error" }));
            return;
          }
          if (req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ STATE: true, WORKING: false }));
            return;
          }
          if (req.method === "PUT") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "applied" }));
            return;
          }
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ title: "Not Found" }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, requests }));
  });
}

function flow(port, extra) {
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
    Object.assign(
      {
        id: "n1",
        type: "openccu-loom-paramset",
        server: "s1",
        address: "000C9709AEF157:1",
        key: "VALUES",
        mode: "read",
        idempotencyKey: "",
        wires: [["n2"]],
      },
      extra || {}
    ),
    { id: "n2", type: "helper" },
  ];
}

describe("openccu-loom-paramset", function () {
  let backend;
  let requests;

  beforeEach(function (done) {
    startBackend().then(({ srv, requests: r }) => {
      backend = srv;
      requests = r;
      helper.startServer(done);
    });
  });

  afterEach(function (done) {
    helper.unload().then(() => helper.stopServer(() => backend.close(done)));
  });

  it("reads the configured paramset via GET /devices/{addr}/paramsets/{key}", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, paramsetNode], flow(port), function () {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { STATE: true, WORKING: false });
          assert.strictEqual(msg.statusCode, 200);
          assert.deepStrictEqual(requests, [
            { method: "GET", url: "/api/v1/devices/000C9709AEF157%3A1/paramsets/VALUES", body: null },
          ]);
          done();
        } catch (e) {
          done(e);
        }
      });
      n1.receive({});
    });
  });

  it("lets msg.mode/key/address/payload switch to a write on a different key", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, paramsetNode], flow(port), function () {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { status: "applied" });
          assert.strictEqual(requests.length, 1);
          assert.strictEqual(requests[0].method, "PUT");
          assert.strictEqual(
            requests[0].url,
            "/api/v1/devices/000C9709AEF157%3A2/paramsets/MASTER"
          );
          assert.deepStrictEqual(requests[0].body, { LOWBAT_LIMIT: 2.2 });
          done();
        } catch (e) {
          done(e);
        }
      });
      n1.receive({
        mode: "write",
        key: "MASTER",
        address: "000C9709AEF157:2",
        payload: { LOWBAT_LIMIT: 2.2 },
      });
    });
  });

  it("errors and emits nothing when the backend fails (500)", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, paramsetNode], flow(port, { address: "BROKEN" }), function () {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      let emitted = false;
      n2.on("input", () => {
        emitted = true;
      });
      const origError = n1.error.bind(n1);
      n1.error = function (err, msg) {
        try {
          const text = err && err.message ? err.message : String(err);
          assert.ok(/500/.test(text), `unexpected error: ${text}`);
          assert.strictEqual(emitted, false, "must not emit a message");
          done();
        } catch (e) {
          done(e);
        }
        return origError(err, msg);
      };
      n1.receive({});
    });
  });
});
