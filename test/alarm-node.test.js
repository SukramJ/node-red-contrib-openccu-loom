"use strict";

const assert = require("assert");
const { WebSocketServer } = require("ws");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const alarmNode = require("../nodes/openccu-loom-alarm.js");
const { getHub } = require("../lib/ws-hub");
const { ALARM_COMMANDS } = alarmNode;

helper.init(require.resolve("node-red"));

// Mirrors the daemon's ws `call` contract (see test/ws-hub.test.js): answer
// every inbound {op:"call"} frame with an outbound {op:"result", id, data|error}.
function startWsServer(onCall) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => resolve(wss));
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        let frame;
        try {
          frame = JSON.parse(raw.toString());
        } catch (_) {
          return;
        }
        if (frame.op === "call") onCall(socket, frame);
      });
    });
  });
}

// The ws hub is keyed by server node id (see lib/ws-hub.js hubKey); every
// test flow below uses id "s1", so the hub created inside the node's
// constructor can be reached here too, to wait for the "open" handshake
// before pushing a message through it.
function waitHubOpen(id) {
  return new Promise((resolve, reject) => {
    const hub = getHub({ id });
    const timer = setTimeout(() => {
      off();
      reject(new Error("ws hub never reached open state"));
    }, 3000);
    const off = hub.onStatus((s) => {
      if (s === "open") {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
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
      { id: "n1", type: "openccu-loom-alarm", server: "s1", wires: [["n2"]] },
      extra || {}
    ),
    { id: "n2", type: "helper" },
  ];
}

describe("openccu-loom-alarm", function () {
  let wss;

  afterEach(function (done) {
    helper.unload().then(() => {
      if (!wss) return done();
      const closing = wss;
      wss = null;
      closing.close(() => done());
    });
  });

  it("exports the action -> wsapi command map", function () {
    assert.deepStrictEqual(ALARM_COMMANDS, {
      state: "alarm_panel.state",
      panels: "alarm_panel.panels",
      readiness: "alarm_panel.readiness",
      journal: "alarm_panel.journal",
      walktest_status: "alarm_panel.walktest_status",
      arm: "alarm_panel.arm",
      disarm: "alarm_panel.disarm",
      silence: "alarm_panel.silence",
      silence_all: "alarm_panel.silence_all",
      acknowledge: "alarm_panel.acknowledge",
    });
  });

  it("uses the configured action and panel default when msg carries neither", function (done) {
    let seen;
    startWsServer((socket, frame) => {
      seen = frame;
      socket.send(JSON.stringify({ op: "result", id: frame.id, data: { ready: true } }));
    }).then((server) => {
      wss = server;
      const port = wss.address().port;
      helper.load([serverNode, alarmNode], flow(port, { action: "readiness", panel: "area-1" }), function () {
        waitHubOpen("s1")
          .then(() => {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            n2.on("input", (msg) => {
              try {
                assert.strictEqual(seen.command, "alarm_panel.readiness");
                assert.deepStrictEqual(seen.args, { area_id: "area-1" });
                assert.deepStrictEqual(msg.payload, { ready: true });
                done();
              } catch (e) {
                done(e);
              }
            });
            n1.receive({});
          })
          .catch(done);
      });
    });
  });

  it("lets msg.action override the configured action", function (done) {
    let seen;
    startWsServer((socket, frame) => {
      seen = frame;
      socket.send(JSON.stringify({ op: "result", id: frame.id, data: {} }));
    }).then((server) => {
      wss = server;
      const port = wss.address().port;
      helper.load([serverNode, alarmNode], flow(port, { action: "state" }), function () {
        waitHubOpen("s1")
          .then(() => {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            n2.on("input", () => {
              try {
                // The configured default ("state") must not be the command
                // that reached the daemon — msg.action overrides it.
                assert.strictEqual(seen.command, "alarm_panel.silence_all");
                assert.deepStrictEqual(seen.args, {});
                done();
              } catch (e) {
                done(e);
              }
            });
            n1.receive({ action: "silence_all" });
          })
          .catch(done);
      });
    });
  });

  it("assembles wsapi-named args from msg fields and lets msg.args win key by key", function (done) {
    let seen;
    startWsServer((socket, frame) => {
      seen = frame;
      socket.send(JSON.stringify({ op: "result", id: frame.id, data: { state: "armed" } }));
    }).then((server) => {
      wss = server;
      const port = wss.address().port;
      helper.load([serverNode, alarmNode], flow(port, { action: "arm", panel: "area-1" }), function () {
        waitHubOpen("s1")
          .then(() => {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            n2.on("input", (msg) => {
              try {
                assert.strictEqual(seen.command, "alarm_panel.arm");
                assert.deepStrictEqual(seen.args, {
                  area_id: "area-9",
                  mode: "home",
                  code: "1234",
                });
                assert.deepStrictEqual(msg.payload, { state: "armed" });
                done();
              } catch (e) {
                done(e);
              }
            });
            n1.receive({
              mode: "home",
              code: "1234",
              args: { area_id: "area-9" },
            });
          })
          .catch(done);
      });
    });
  });

  it("errors via done() without emitting when the daemon returns an error frame", function (done) {
    startWsServer((socket, frame) => {
      socket.send(
        JSON.stringify({
          op: "result",
          id: frame.id,
          error: { code: "invalid_code", message: "wrong code" },
        })
      );
    }).then((server) => {
      wss = server;
      const port = wss.address().port;
      helper.load([serverNode, alarmNode], flow(port, { action: "disarm", panel: "area-1" }), function () {
        waitHubOpen("s1")
          .then(() => {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");
            let emitted = false;
            n2.on("input", () => {
              emitted = true;
            });
            const origError = n1.error.bind(n1);
            n1.error = function (err, msg) {
              try {
                assert.strictEqual(err.message, "wrong code");
                assert.strictEqual(err.details.code, "invalid_code");
                assert.strictEqual(emitted, false, "must not emit a message");
                done();
              } catch (e) {
                done(e);
              }
              return origError(err, msg);
            };
            n1.receive({});
          })
          .catch(done);
      });
    });
  });
});
