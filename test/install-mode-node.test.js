"use strict";

const assert = require("assert");
const http = require("http");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const installModeNode = require("../nodes/openccu-loom-install-mode.js");

helper.init(require.resolve("node-red"));

const INTERFACES = [
  { interface: "HmIP-RF", active: false, remaining: 0 },
  { interface: "BidCos-RF", active: true, remaining: 30 },
];

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

        if (req.url === "/api/v1/install-mode/interfaces" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(INTERFACES));
          return;
        }
        if (req.url === "/api/v1/install-mode/interfaces" && req.method === "POST") {
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify(Object.assign({ status: "accepted" }, body)));
          return;
        }
        const m = req.url.match(/^\/api\/v1\/devices\/([^/]+)\/install-mode$/);
        if (m && req.method === "POST") {
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(Object.assign({ address: decodeURIComponent(m[1]), status: "accepted" }, body))
          );
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
      { id: "n1", type: "openccu-loom-install-mode", server: "s1", action: "status", seconds: 0, wires: [["n2"]] },
      extra || {}
    ),
    { id: "n2", type: "helper" },
  ];
}

describe("openccu-loom-install-mode", function () {
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

  it("action 'status' fetches GET /install-mode/interfaces", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, installModeNode], flow(port), function () {
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, INTERFACES);
          assert.deepStrictEqual(requests, [
            { method: "GET", url: "/api/v1/install-mode/interfaces", body: null },
          ]);
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode("n1").receive({});
    });
  });

  it("action 'status' with msg.interface filters the returned array", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, installModeNode], flow(port), function () {
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, [{ interface: "HmIP-RF", active: false, remaining: 0 }]);
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode("n1").receive({ interface: "HmIP-RF" });
    });
  });

  it("action 'start' with msg.interface POSTs {interface, active:true, seconds}", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, installModeNode], flow(port, { action: "start", seconds: 45 }), function () {
      const n2 = helper.getNode("n2");
      n2.on("input", () => {
        try {
          assert.deepStrictEqual(requests, [
            {
              method: "POST",
              url: "/api/v1/install-mode/interfaces",
              body: { interface: "HmIP-RF", active: true, seconds: 45 },
            },
          ]);
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode("n1").receive({ interface: "HmIP-RF" });
    });
  });

  it("action 'stop' POSTs {interface, active:false} (no seconds)", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, installModeNode], flow(port, { action: "stop", seconds: 45 }), function () {
      const n2 = helper.getNode("n2");
      n2.on("input", () => {
        try {
          assert.deepStrictEqual(requests, [
            {
              method: "POST",
              url: "/api/v1/install-mode/interfaces",
              body: { interface: "HmIP-RF", active: false },
            },
          ]);
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode("n1").receive({ interface: "HmIP-RF" });
    });
  });

  it("action 'start' with msg.address opens a device-targeted install-mode window", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, installModeNode], flow(port, { action: "start", seconds: 20 }), function () {
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { address: "AABBCC", status: "accepted", seconds: 20 });
          assert.deepStrictEqual(requests, [
            { method: "POST", url: "/api/v1/devices/AABBCC/install-mode", body: { seconds: 20 } },
          ]);
          done();
        } catch (e) {
          done(e);
        }
      });
      helper.getNode("n1").receive({ address: "AABBCC" });
    });
  });

  it("action 'start' without an interface and without an address errors, without calling the backend", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, installModeNode], flow(port, { action: "start" }), function () {
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
          assert.ok(/interface is required/.test(text), `unexpected error: ${text}`);
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
});
