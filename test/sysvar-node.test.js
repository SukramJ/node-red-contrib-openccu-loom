"use strict";

const assert = require("assert");
const http = require("http");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const sysvarNode = require("../nodes/openccu-loom-sysvar.js");

helper.init(require.resolve("node-red"));

const SYSVARS = {
  Presence: { name: "Presence", value: true },
};

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

        if (req.url === "/api/v1/sysvars" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(Object.values(SYSVARS)));
          return;
        }
        const m = req.url.match(/^\/api\/v1\/sysvars\/([^/]+)$/);
        if (m) {
          const name = decodeURIComponent(m[1]);
          if (req.method === "GET") {
            const sv = SYSVARS[name];
            if (!sv) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ title: "Not Found" }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(sv));
            return;
          }
          if (req.method === "PUT") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ name, value: body ? body.value : null }));
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
        type: "openccu-loom-sysvar",
        server: "s1",
        sysvar: "Presence",
        mode: "read",
        wires: [["n2"]],
      },
      extra || {}
    ),
    { id: "n2", type: "helper" },
  ];
}

describe("openccu-loom-sysvar", function () {
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

  it("reads the configured sysvar via GET /sysvars/{name}", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, sysvarNode], flow(port), function () {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { name: "Presence", value: true });
          assert.strictEqual(msg.statusCode, 200);
          assert.deepStrictEqual(requests, [
            { method: "GET", url: "/api/v1/sysvars/Presence", body: null },
          ]);
          done();
        } catch (e) {
          done(e);
        }
      });
      n1.receive({});
    });
  });

  it("lets msg.mode/sysvar switch to a write with msg.payload as the value", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, sysvarNode], flow(port), function () {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { name: "Vacation", value: false });
          assert.strictEqual(requests.length, 1);
          assert.strictEqual(requests[0].method, "PUT");
          assert.strictEqual(requests[0].url, "/api/v1/sysvars/Vacation");
          assert.deepStrictEqual(requests[0].body, { value: false });
          done();
        } catch (e) {
          done(e);
        }
      });
      n1.receive({ mode: "write", sysvar: "Vacation", payload: false });
    });
  });

  it("errors and emits nothing when the sysvar is unknown (404)", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, sysvarNode], flow(port, { sysvar: "DoesNotExist" }), function () {
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
          assert.ok(/404/.test(text), `unexpected error: ${text}`);
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
