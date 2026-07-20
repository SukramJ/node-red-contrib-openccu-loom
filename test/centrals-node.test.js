"use strict";

const assert = require("assert");
const http = require("http");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const centralsNode = require("../nodes/openccu-loom-centrals.js");

helper.init(require.resolve("node-red"));

const CENTRALS = {
  Home: { name: "Home", host: "192.168.1.10" },
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

        if (req.url === "/api/v1/centrals" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(Object.values(CENTRALS)));
          return;
        }
        const m = req.url.match(/^\/api\/v1\/centrals\/([^/]+)$/);
        if (m) {
          const name = decodeURIComponent(m[1]);
          if (req.method === "GET") {
            const row = CENTRALS[name];
            if (!row) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ title: "Not Found" }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(row));
            return;
          }
          if (req.method === "PUT") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(Object.assign({ name }, body)));
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
      { id: "n1", type: "openccu-loom-centrals", server: "s1", action: "list", centralName: "", wires: [["n2"]] },
      extra || {}
    ),
    { id: "n2", type: "helper" },
  ];
}

describe("openccu-loom-centrals", function () {
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

  it("lists centrals via GET /centrals", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, centralsNode], flow(port), function () {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, [{ name: "Home", host: "192.168.1.10" }]);
          assert.strictEqual(msg.statusCode, 200);
          assert.deepStrictEqual(requests, [
            { method: "GET", url: "/api/v1/centrals", body: null },
          ]);
          done();
        } catch (e) {
          done(e);
        }
      });
      n1.receive({});
    });
  });

  it("lets msg.action/centralName/payload switch to an update", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, centralsNode], flow(port), function () {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { name: "Office", host: "10.0.0.5" });
          assert.strictEqual(requests.length, 1);
          assert.strictEqual(requests[0].method, "PUT");
          assert.strictEqual(requests[0].url, "/api/v1/centrals/Office");
          assert.deepStrictEqual(requests[0].body, { host: "10.0.0.5" });
          done();
        } catch (e) {
          done(e);
        }
      });
      n1.receive({ action: "update", centralName: "Office", payload: { host: "10.0.0.5" } });
    });
  });

  it("errors and emits nothing when the central is unknown (404)", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, centralsNode], flow(port), function () {
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
      n1.receive({ action: "get", centralName: "Missing" });
    });
  });
});
