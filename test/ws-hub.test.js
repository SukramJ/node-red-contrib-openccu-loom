"use strict";

const assert = require("assert");
const { WebSocketServer } = require("ws");
const { getHub, releaseHub } = require("../lib/ws-hub");

// Spins up a throwaway WS server that mirrors the daemon's `call`
// contract: it answers an inbound {op:"call"} frame with an outbound
// {op:"result", id, data|error} frame (see openccu-loom ws hub.go:56).
function startWsServer(onCall) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => {
      resolve(wss);
    });
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

function serverConfig(port, id) {
  return {
    id,
    host: "127.0.0.1",
    port,
    tls: false,
    authMethod: "basic",
    timeout: 2000,
    credentials: { username: "u", password: "p" },
  };
}

function waitOpen(hub) {
  return new Promise((resolve, reject) => {
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

describe("WsHub.call", function () {
  it("resolves a call with the result frame's `data` field", function (done) {
    startWsServer((socket, frame) => {
      socket.send(
        JSON.stringify({
          op: "result",
          id: frame.id,
          data: { echoed: frame.command, args: frame.args },
        })
      );
    }).then(async (wss) => {
      const port = wss.address().port;
      const server = serverConfig(port, "wshub-data");
      const hub = getHub(server);
      hub.addRef();
      try {
        await waitOpen(hub);
        const result = await hub.call("devices.list", { foo: 1 });
        assert.deepStrictEqual(result, {
          echoed: "devices.list",
          args: { foo: 1 },
        });
        releaseHub(server);
        wss.close(() => done());
      } catch (e) {
        releaseHub(server);
        wss.close(() => done(e));
      }
    });
  });

  it("rejects a call when the result frame carries an error", function (done) {
    startWsServer((socket, frame) => {
      socket.send(
        JSON.stringify({
          op: "result",
          id: frame.id,
          error: { code: "rate_limited", message: "slow down" },
        })
      );
    }).then(async (wss) => {
      const port = wss.address().port;
      const server = serverConfig(port, "wshub-error");
      const hub = getHub(server);
      hub.addRef();
      try {
        await waitOpen(hub);
        await assert.rejects(
          () => hub.call("sysvars.set", {}),
          (err) => {
            assert.strictEqual(err.message, "slow down");
            assert.strictEqual(err.details.code, "rate_limited");
            return true;
          }
        );
        releaseHub(server);
        wss.close(() => done());
      } catch (e) {
        releaseHub(server);
        wss.close(() => done(e));
      }
    });
  });
});
