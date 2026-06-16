"use strict";

const assert = require("assert");
const http = require("http");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const programNode = require("../nodes/openccu-loom-program.js");

helper.init(require.resolve("node-red"));

// The daemon exposes no single-program endpoint — only GET /programs
// (list), POST /programs/{id}/execute and PATCH /programs/{id}. The
// "get" mode therefore fetches the list and filters by id locally.
const PROGRAMS = [
  { id: "111", name: "Wakeup", active: true },
  { id: "222", name: "Goodnight", active: false },
];

function startBackend(onRequest) {
  return new Promise((resolve) => {
    const srv = http.createServer(onRequest);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
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
      { id: "n1", type: "openccu-loom-program", server: "s1", wires: [["n2"]] },
      extra || {}
    ),
    { id: "n2", type: "helper" },
  ];
}

describe("openccu-loom-program get mode", function () {
  let backend;
  let requestedUrls;

  beforeEach(function (done) {
    requestedUrls = [];
    startBackend((req, res) => {
      requestedUrls.push(req.url);
      if (req.url === "/api/v1/programs") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(PROGRAMS));
        return;
      }
      // Any per-id path would be a regression — answer 404 so the test
      // fails loudly if the node ever calls GET /programs/{id} again.
      res.writeHead(404);
      res.end();
    }).then((srv) => {
      backend = srv;
      helper.startServer(done);
    });
  });

  afterEach(function (done) {
    helper.unload().then(() => helper.stopServer(() => backend.close(done)));
  });

  it("fetches the list and returns the matching program", function (done) {
    const port = backend.address().port;
    helper.load(
      [serverNode, programNode],
      flow(port, { mode: "get", programId: "222" }),
      function () {
        const n1 = helper.getNode("n1");
        const n2 = helper.getNode("n2");
        n2.on("input", (msg) => {
          try {
            assert.deepStrictEqual(msg.payload, {
              id: "222",
              name: "Goodnight",
              active: false,
            });
            // It must hit the list endpoint, never a per-id path.
            assert.deepStrictEqual(requestedUrls, ["/api/v1/programs"]);
            done();
          } catch (e) {
            done(e);
          }
        });
        n1.receive({});
      }
    );
  });

  it("lets msg.programId override the configured id", function (done) {
    const port = backend.address().port;
    helper.load(
      [serverNode, programNode],
      flow(port, { mode: "get", programId: "222" }),
      function () {
        const n1 = helper.getNode("n1");
        const n2 = helper.getNode("n2");
        n2.on("input", (msg) => {
          try {
            assert.strictEqual(msg.payload.id, "111");
            done();
          } catch (e) {
            done(e);
          }
        });
        n1.receive({ programId: "111" });
      }
    );
  });

  it("errors and emits nothing when the program id is unknown", function (done) {
    const port = backend.address().port;
    helper.load(
      [serverNode, programNode],
      flow(port, { mode: "get", programId: "999" }),
      function () {
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
            assert.ok(
              /program not found: 999/.test(text),
              `unexpected error: ${text}`
            );
            assert.strictEqual(emitted, false, "must not emit a message");
            done();
          } catch (e) {
            done(e);
          }
          return origError(err, msg);
        };
        n1.receive({});
      }
    );
  });
});
