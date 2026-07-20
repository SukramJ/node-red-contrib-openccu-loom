"use strict";

const assert = require("assert");
const http = require("http");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const deviceAdminNode = require("../nodes/openccu-loom-device-admin.js");

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

        if (req.url === "/api/v1/devices/values:batch" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json", "Idempotent-Replay": "true" });
          res.end(JSON.stringify({ accepted: (body && body.values && body.values.length) || 0 }));
          return;
        }
        if (req.url === "/api/v1/devices/refresh" && req.method === "POST") {
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "reconciling" }));
          return;
        }
        const accept = req.url.match(/^\/api\/v1\/devices\/([^/]+)\/accept$/);
        if (accept && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ address: decodeURIComponent(accept[1]), accepted: true }));
          return;
        }
        const firmware = req.url.match(/^\/api\/v1\/devices\/([^/]+)\/firmware\/update$/);
        if (firmware && req.method === "POST") {
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ address: decodeURIComponent(firmware[1]), status: "updating" }));
          return;
        }
        const del = req.url.match(/^\/api\/v1\/devices\/([^/]+)$/);
        if (del && req.method === "DELETE") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ address: decodeURIComponent(del[1]), deleted: true }));
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
      { id: "n1", type: "openccu-loom-device-admin", server: "s1", action: "refresh", address: "", wires: [["n2"]] },
      extra || {}
    ),
    { id: "n2", type: "helper" },
  ];
}

describe("openccu-loom-device-admin", function () {
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

  it("action 'batch' POSTs {values: msg.payload} to /devices/values:batch and flags an idempotent replay", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, deviceAdminNode], flow(port, { action: "batch" }), function () {
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { accepted: 1 });
          assert.strictEqual(msg.idempotentReplay, true);
          assert.deepStrictEqual(requests, [
            {
              method: "POST",
              url: "/api/v1/devices/values:batch",
              body: { values: [{ address: "AABBCC", channel: 1, parameter: "STATE", value: true }] },
            },
          ]);
          done();
        } catch (e) {
          done(e);
        }
      });
      helper
        .getNode("n1")
        .receive({ payload: [{ address: "AABBCC", channel: 1, parameter: "STATE", value: true }] });
    });
  });

  it("action 'batch' errors when msg.payload is not an array, without calling the backend", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, deviceAdminNode], flow(port, { action: "batch" }), function () {
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
          assert.ok(/must be an array/.test(text), `unexpected error: ${text}`);
          assert.strictEqual(emitted, false, "must not emit a message");
          assert.strictEqual(requests.length, 0, "must not call the backend");
          done();
        } catch (e) {
          done(e);
        }
        return origError(err, msg);
      };
      n1.receive({ payload: { not: "an array" } });
    });
  });

  it("action 'refresh' POSTs /devices/refresh (default action)", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, deviceAdminNode], flow(port), function () {
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { status: "reconciling" });
          assert.deepStrictEqual(requests, [
            { method: "POST", url: "/api/v1/devices/refresh", body: null },
          ]);
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode("n1").receive({});
    });
  });

  it("action 'accept' POSTs /devices/{addr}/accept", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, deviceAdminNode], flow(port, { action: "accept", address: "AABBCC" }), function () {
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { address: "AABBCC", accepted: true });
          assert.deepStrictEqual(requests, [
            { method: "POST", url: "/api/v1/devices/AABBCC/accept", body: null },
          ]);
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode("n1").receive({});
    });
  });

  it("action 'accept' errors when the address is missing", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, deviceAdminNode], flow(port, { action: "accept" }), function () {
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
          assert.ok(/address missing/.test(text), `unexpected error: ${text}`);
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

  it("action 'firmware' POSTs /devices/{addr}/firmware/update", function (done) {
    const port = backend.address().port;
    helper.load(
      [serverNode, deviceAdminNode],
      flow(port, { action: "firmware", address: "AABBCC" }),
      function () {
        const n2 = helper.getNode("n2");
        n2.on("input", (msg) => {
          try {
            assert.deepStrictEqual(msg.payload, { address: "AABBCC", status: "updating" });
            assert.deepStrictEqual(requests, [
              { method: "POST", url: "/api/v1/devices/AABBCC/firmware/update", body: null },
            ]);
            done();
          } catch (e) {
            done(e);
          }
        });
        helper.getNode("n1").receive({});
      }
    );
  });

  it("action 'delete' DELETEs /devices/{addr}", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, deviceAdminNode], flow(port, { action: "delete", address: "AABBCC" }), function () {
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { address: "AABBCC", deleted: true });
          assert.deepStrictEqual(requests, [
            { method: "DELETE", url: "/api/v1/devices/AABBCC", body: null },
          ]);
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode("n1").receive({});
    });
  });

  it("errors and emits nothing for an unknown action", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, deviceAdminNode], flow(port, { action: "bogus" }), function () {
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
          assert.ok(/unknown action: bogus/.test(text), `unexpected error: ${text}`);
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
