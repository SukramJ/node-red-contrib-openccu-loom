"use strict";

const assert = require("assert");
const http = require("http");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const interfacesNode = require("../nodes/openccu-loom-interfaces.js");

helper.init(require.resolve("node-red"));

const INTERFACES = {
  "HmIP-RF": { id: "HmIP-RF", connected: true },
};

function startBackend() {
  return new Promise((resolve) => {
    const requests = [];
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.url !== "/api/v1/info") requests.push({ method: req.method, url: req.url });

        if (req.url === "/api/v1/interfaces" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(Object.values(INTERFACES)));
          return;
        }
        const reconnect = req.url.match(/^\/api\/v1\/interfaces\/([^/]+)\/reconnect$/);
        if (reconnect && req.method === "POST") {
          const id = decodeURIComponent(reconnect[1]);
          if (!INTERFACES[id]) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ title: "Not Found" }));
            return;
          }
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id, status: "reconnecting" }));
          return;
        }
        const get = req.url.match(/^\/api\/v1\/interfaces\/([^/]+)$/);
        if (get && req.method === "GET") {
          const id = decodeURIComponent(get[1]);
          const iface = INTERFACES[id];
          if (!iface) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ title: "Not Found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(iface));
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
      { id: "n1", type: "openccu-loom-interfaces", server: "s1", action: "list", wires: [["n2"]] },
      extra || {}
    ),
    { id: "n2", type: "helper" },
  ];
}

describe("openccu-loom-interfaces", function () {
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

  it("lists interfaces via GET /interfaces", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, interfacesNode], flow(port), function () {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, [{ id: "HmIP-RF", connected: true }]);
          assert.strictEqual(msg.statusCode, 200);
          assert.deepStrictEqual(requests, [
            { method: "GET", url: "/api/v1/interfaces" },
          ]);
          done();
        } catch (e) {
          done(e);
        }
      });
      n1.receive({});
    });
  });

  it("lets msg.action/id switch to a reconnect", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, interfacesNode], flow(port), function () {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { id: "HmIP-RF", status: "reconnecting" });
          assert.strictEqual(msg.statusCode, 202);
          assert.deepStrictEqual(requests, [
            { method: "POST", url: "/api/v1/interfaces/HmIP-RF/reconnect" },
          ]);
          done();
        } catch (e) {
          done(e);
        }
      });
      n1.receive({ action: "reconnect", id: "HmIP-RF" });
    });
  });

  it("errors and emits nothing when the interface is unknown (404)", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, interfacesNode], flow(port), function () {
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
      n1.receive({ action: "get", id: "Unknown" });
    });
  });
});
