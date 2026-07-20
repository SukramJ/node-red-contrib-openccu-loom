"use strict";

const assert = require("assert");
const http = require("http");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const healthNode = require("../nodes/openccu-loom-health.js");

helper.init(require.resolve("node-red"));

function startBackend() {
  return new Promise((resolve) => {
    const requests = [];
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.url !== "/api/v1/info") requests.push({ method: req.method, url: req.url });

        const known = {
          "/api/v1/health": { status: "ok" },
          "/api/v1/system/ccu": { name: "Home", reachable: true },
          "/api/v1/config": { section: "config" },
          "/api/v1/config/effective": { section: "effective" },
          "/api/v1/config/schema": { section: "schema" },
        };
        if (req.method === "GET" && known[req.url]) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(known[req.url]));
          return;
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
      { id: "n1", type: "openccu-loom-health", server: "s1", scope: "health", wires: [["n2"]] },
      extra || {}
    ),
    { id: "n2", type: "helper" },
  ];
}

describe("openccu-loom-health", function () {
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

  it("fetches /health by default", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, healthNode], flow(port), function () {
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { status: "ok" });
          assert.strictEqual(msg.statusCode, 200);
          assert.deepStrictEqual(requests, [{ method: "GET", url: "/api/v1/health" }]);
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode("n1").receive({});
    });
  });

  it("hits GET /system/ccu for scope 'ccu'", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, healthNode], flow(port), function () {
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { name: "Home", reachable: true });
          assert.deepStrictEqual(requests, [{ method: "GET", url: "/api/v1/system/ccu" }]);
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode("n1").receive({ scope: "ccu" });
    });
  });

  it("hits GET /config/schema for scope 'config-schema'", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, healthNode], flow(port), function () {
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { section: "schema" });
          assert.deepStrictEqual(requests, [{ method: "GET", url: "/api/v1/config/schema" }]);
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode("n1").receive({ scope: "config-schema" });
    });
  });

  it("errors and emits nothing for an unknown scope, without calling the backend", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, healthNode], flow(port), function () {
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
          assert.ok(/unknown scope: bogus/.test(text), `unexpected error: ${text}`);
          assert.strictEqual(emitted, false, "must not emit a message");
          assert.strictEqual(requests.length, 0, "must not call the backend");
          done();
        } catch (e) {
          done(e);
        }
        return origError(err, msg);
      };
      n1.receive({ scope: "bogus" });
    });
  });
});
