"use strict";

const assert = require("assert");
const http = require("http");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const setValueNode = require("../nodes/openccu-loom-set-value.js");

helper.init(require.resolve("node-red"));

// Records every request the node issues against the fake daemon, parsing
// the JSON body when present. Channel "99" is a sentinel that makes the
// backend respond 500 so the error path can be exercised without a second
// server instance.
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

        const m = req.url.match(
          /^\/api\/v1\/devices\/([^/]+)\/channels\/([^/]+)\/data-points\/([^/]+)\/value$/
        );
        if (req.method === "PUT" && m) {
          if (m[2] === "99") {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ title: "Internal Server Error", detail: "boom" }));
            return;
          }
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "accepted" }));
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
      {
        id: "n1",
        type: "openccu-loom-set-value",
        server: "s1",
        address: "000C9709AEF157",
        channel: "1",
        parameter: "STATE",
        priority: "",
        idempotencyKey: "",
        wires: [["n2"]],
      },
      extra || {}
    ),
    { id: "n2", type: "helper" },
  ];
}

describe("openccu-loom-set-value", function () {
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

  it("PUTs the configured address/channel/parameter with msg.payload as value", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, setValueNode], flow(port), function () {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.deepStrictEqual(msg.payload, { status: "accepted" });
          assert.strictEqual(msg.statusCode, 202);
          assert.strictEqual(requests.length, 1);
          assert.strictEqual(requests[0].method, "PUT");
          assert.strictEqual(
            requests[0].url,
            "/api/v1/devices/000C9709AEF157/channels/1/data-points/STATE/value"
          );
          assert.deepStrictEqual(requests[0].body, { value: true });
          done();
        } catch (e) {
          done(e);
        }
      });
      n1.receive({ payload: true });
    });
  });

  it("lets msg.address/channel/parameter/priority override the configured fields", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, setValueNode], flow(port), function () {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      n2.on("input", (msg) => {
        try {
          assert.strictEqual(requests.length, 1);
          assert.strictEqual(
            requests[0].url,
            "/api/v1/devices/OTHERADDR/channels/2/data-points/LEVEL/value"
          );
          assert.deepStrictEqual(requests[0].body, { value: 0.5, priority: "high" });
          done();
        } catch (e) {
          done(e);
        }
      });
      n1.receive({
        payload: 0.5,
        address: "OTHERADDR",
        channel: 2,
        parameter: "LEVEL",
        priority: "high",
      });
    });
  });

  it("errors and emits nothing when the backend rejects the write (500)", function (done) {
    const port = backend.address().port;
    helper.load([serverNode, setValueNode], flow(port, { channel: "99" }), function () {
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
      n1.receive({ payload: 1 });
    });
  });
});
