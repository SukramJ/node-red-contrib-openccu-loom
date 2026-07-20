"use strict";

const assert = require("assert");
const { WebSocketServer } = require("ws");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const eventsNode = require("../nodes/openccu-loom-events.js");

helper.init(require.resolve("node-red"));

// Spins up a throwaway WS server that mirrors the daemon's event-stream
// contract: it receives {op:"subscribe"|"unsubscribe", topics} frames and
// can push event / control frames back on the same socket (see
// openccu-loom-events.js and test/ws-hub.test.js for the same pattern).
function startWsServer(onMessage) {
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
        onMessage(socket, frame);
      });
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
      { id: "n1", type: "openccu-loom-events", server: "s1", topics: "", wires: [["n2"]] },
      extra || {}
    ),
    { id: "n2", type: "helper" },
  ];
}

describe("openccu-loom-events", function () {
  let wss;

  afterEach(function (done) {
    helper.unload().then(() => {
      if (!wss) return done();
      const closing = wss;
      wss = null;
      closing.close(() => done());
    });
  });

  it("forwards the configured topics to the ws server as a subscribe frame", function (done) {
    startWsServer((_socket, frame) => {
      if (frame.op !== "subscribe") return;
      try {
        assert.deepStrictEqual(frame.topics, ["device.*", "hub.*"]);
        done();
      } catch (e) {
        done(e);
      }
    }).then((server) => {
      wss = server;
      const port = wss.address().port;
      helper.load([serverNode, eventsNode], flow(port, { topics: "device.*,hub.*" }), function () {});
    });
  });

  it("delivers an incoming event frame as msg.topic/eventType/kind/seq", function (done) {
    startWsServer((socket, frame) => {
      if (frame.op !== "subscribe") return;
      socket.send(
        JSON.stringify({
          topic: "device.CHANGED",
          type: "value_changed",
          kind: "change",
          seq: 7,
          data: { x: 1 },
        })
      );
    }).then((server) => {
      wss = server;
      const port = wss.address().port;
      helper.load([serverNode, eventsNode], flow(port, { topics: "device.*" }), function () {
        const n2 = helper.getNode("n2");
        n2.on("input", (msg) => {
          try {
            assert.strictEqual(msg.topic, "device.CHANGED");
            assert.strictEqual(msg.eventType, "value_changed");
            assert.strictEqual(msg.kind, "change");
            assert.strictEqual(msg.seq, 7);
            assert.deepStrictEqual(msg.payload, {
              topic: "device.CHANGED",
              type: "value_changed",
              kind: "change",
              seq: 7,
              data: { x: 1 },
            });
            done();
          } catch (e) {
            done(e);
          }
        });
      });
    });
  });

  it("does not emit a flow message for a {op:'subscribed'} ack — it only updates node.status", function (done) {
    startWsServer((socket, frame) => {
      if (frame.op !== "subscribe") return;
      socket.send(JSON.stringify({ op: "subscribed", topics: frame.topics }));
    }).then((server) => {
      wss = server;
      const port = wss.address().port;
      helper.load([serverNode, eventsNode], flow(port, { topics: "device.*" }), function () {
        const n1 = helper.getNode("n1");
        const n2 = helper.getNode("n2");
        let emitted = false;
        n2.on("input", () => {
          emitted = true;
        });
        const statusCalls = [];
        const origStatus = n1.status.bind(n1);
        n1.status = function (s) {
          statusCalls.push(s);
          return origStatus(s);
        };
        setTimeout(() => {
          try {
            assert.strictEqual(emitted, false, "the subscribed ack must not reach the flow");
            assert.ok(
              statusCalls.some((s) => s && s.text === "subscribed (1 topics)"),
              `expected a "subscribed (1 topics)" status update, got ${JSON.stringify(statusCalls)}`
            );
            done();
          } catch (e) {
            done(e);
          }
        }, 250);
      });
    });
  });

  it("delivers a replay_done control frame as a control message", function (done) {
    startWsServer((socket, frame) => {
      if (frame.op !== "subscribe") return;
      socket.send(JSON.stringify({ op: "replay_done", seq: 42 }));
    }).then((server) => {
      wss = server;
      const port = wss.address().port;
      helper.load([serverNode, eventsNode], flow(port, { topics: "device.*" }), function () {
        const n2 = helper.getNode("n2");
        n2.on("input", (msg) => {
          try {
            assert.strictEqual(msg.control, "replay_done");
            assert.deepStrictEqual(msg.payload, { control: "replay_done", seq: 42 });
            done();
          } catch (e) {
            done(e);
          }
        });
      });
    });
  });
});
