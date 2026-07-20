"use strict";

const assert = require("assert");
const http = require("http");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const apiNode = require("../nodes/openccu-loom-api.js");

helper.init(require.resolve("node-red"));

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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ echo: req.url, method: req.method }));
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
      { id: "n1", type: "openccu-loom-api", server: "s1", method: "GET", path: "", wires: [["n2"]] },
      extra || {}
    ),
    { id: "n2", type: "helper" },
  ];
}

describe("openccu-loom-api", function () {
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

  it("uses the configured method/path when msg carries neither", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, apiNode], flow(port, { method: "GET", path: "/devices" }), function () {
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(requests, [{ method: "GET", url: "/api/v1/devices", body: null }]);
          assert.deepStrictEqual(msg.payload, { echo: "/api/v1/devices", method: "GET" });
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode("n1").receive({});
    });
  });

  it("turns msg.query into the URL query string", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, apiNode], flow(port, { method: "GET", path: "/devices" }), function () {
      const n2 = helper.getNode("n2");
      n2.on("input", () => {
        try {
          assert.strictEqual(requests.length, 1);
          assert.strictEqual(requests[0].url, "/api/v1/devices?type=SWITCH&limit=5");
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode("n1").receive({ query: { type: "SWITCH", limit: 5 } });
    });
  });

  it("lets msg.method/path/payload override the configured fields", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, apiNode], flow(port, { method: "GET", path: "/devices" }), function () {
      const n2 = helper.getNode("n2");
      n2.on("input", () => {
        try {
          assert.deepStrictEqual(requests, [
            { method: "POST", url: "/api/v1/sysvars", body: { name: "x", value: 1 } },
          ]);
          done();
        } catch (e) {
          done(e);
        }
      });
      helper
        .getNode("n1")
        .receive({ method: "post", path: "sysvars", payload: { name: "x", value: 1 } });
    });
  });

  it("errors and emits nothing when the path is missing", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, apiNode], flow(port), function () {
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
          assert.ok(/path missing/.test(text), `unexpected error: ${text}`);
          assert.strictEqual(emitted, false, "must not emit a message");
          assert.strictEqual(requests.length, 0, "must not call the backend");
          done();
        } catch (e) {
          done(e);
        }
        return origError(err, msg);
      };
      n1.receive({});
    });
  });

  it("errors and emits nothing for a disallowed method", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, apiNode], flow(port, { method: "GET", path: "/devices" }), function () {
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
          assert.ok(/method not allowed: TRACE/.test(text), `unexpected error: ${text}`);
          assert.strictEqual(emitted, false, "must not emit a message");
          assert.strictEqual(requests.length, 0, "must not call the backend");
          done();
        } catch (e) {
          done(e);
        }
        return origError(err, msg);
      };
      n1.receive({ method: "TRACE" });
    });
  });
});
