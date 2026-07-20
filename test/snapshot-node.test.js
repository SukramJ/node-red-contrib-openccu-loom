"use strict";

const assert = require("assert");
const http = require("http");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const snapshotNode = require("../nodes/openccu-loom-snapshot.js");

helper.init(require.resolve("node-red"));

const SNAPSHOT = { devices: [{ address: "000C9709AEF157" }], programs: [], sysvars: [] };

function startBackend(mode) {
  return new Promise((resolve) => {
    const requests = [];
    const srv = http.createServer((req, res) => {
      if (req.url !== "/api/v1/info") requests.push({ method: req.method, url: req.url });
      if (req.url === "/api/v1/snapshot" && req.method === "GET") {
        if (mode === "fail") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ title: "Internal Server Error" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(SNAPSHOT));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ title: "Not Found" }));
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
      { id: "n1", type: "openccu-loom-snapshot", server: "s1", wires: [["n2"]] },
      extra || {}
    ),
    { id: "n2", type: "helper" },
  ];
}

describe("openccu-loom-snapshot", function () {
  let backend;
  let requests;

  afterEach(function (done) {
    helper.unload().then(() => helper.stopServer(() => backend.close(done)));
  });

  it("fetches the full snapshot via GET /snapshot", function (done) {
    startBackend("ok").then(({ srv, requests: r }) => {
      backend = srv;
      requests = r;
      helper.startServer(function () {
        const port = backend.address().port;
        helper.load([serverNode, snapshotNode], flow(port), function () {
          const n1 = helper.getNode("n1");
          const n2 = helper.getNode("n2");
          n2.on("input", (msg) => {
            try {
              assert.deepStrictEqual(msg.payload, SNAPSHOT);
              assert.strictEqual(msg.statusCode, 200);
              assert.deepStrictEqual(requests, [{ method: "GET", url: "/api/v1/snapshot" }]);
              done();
            } catch (e) {
              done(e);
            }
          });
          n1.receive({});
        });
      });
    });
  });

  // The node takes no per-message configuration — every input triggers the
  // same GET /snapshot. The msg-override contract here is that unrelated
  // incoming msg fields (topic, correlation ids, …) survive the round trip
  // because the node mutates and forwards the same msg object rather than
  // replacing it, and each distinct message triggers its own fresh fetch.
  it("preserves unrelated msg fields and re-fetches for every message", function (done) {
    startBackend("ok").then(({ srv, requests: r }) => {
      backend = srv;
      requests = r;
      helper.startServer(function () {
        const port = backend.address().port;
        helper.load([serverNode, snapshotNode], flow(port), function () {
          const n1 = helper.getNode("n1");
          const n2 = helper.getNode("n2");
          const seen = [];
          n2.on("input", (msg) => {
            seen.push(msg);
            if (seen.length < 2) return;
            try {
              assert.strictEqual(seen[0].topic, "resync");
              assert.strictEqual(seen[0].correlationId, "abc");
              assert.deepStrictEqual(seen[0].payload, SNAPSHOT);
              assert.strictEqual(seen[1].topic, "resync-2");
              assert.strictEqual(requests.length, 2);
              assert.deepStrictEqual(requests[0], { method: "GET", url: "/api/v1/snapshot" });
              assert.deepStrictEqual(requests[1], { method: "GET", url: "/api/v1/snapshot" });
              done();
            } catch (e) {
              done(e);
            }
          });
          n1.receive({ topic: "resync", correlationId: "abc" });
          n1.receive({ topic: "resync-2" });
        });
      });
    });
  });

  it("errors and emits nothing when the backend fails (500)", function (done) {
    startBackend("fail").then(({ srv, requests: r }) => {
      backend = srv;
      requests = r;
      helper.startServer(function () {
        const port = backend.address().port;
        helper.load([serverNode, snapshotNode], flow(port), function () {
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
  });
});
