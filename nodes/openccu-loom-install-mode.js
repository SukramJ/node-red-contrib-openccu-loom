"use strict";

const { createClient, describeError } = require("../lib/client");

module.exports = function (RED) {
  function OpenccuLoomInstallModeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    if (!server) {
      node.status({ fill: "red", shape: "ring", text: "no server" });
      return;
    }
    const client = createClient(server);

    node.on("input", async (msg, send, done) => {
      const action = msg.action || config.action || "status";
      const iface = msg.interface || config.interface || "";
      const address = msg.address || "";
      const seconds = msg.seconds != null ? Number(msg.seconds) : Number(config.seconds || 0);

      node.status({ fill: "yellow", shape: "ring", text: action });
      try {
        let res;
        if (action === "status") {
          // Per-interface install-mode state; optionally narrowed to
          // one interface for convenience.
          res = await client.get("/install-mode/interfaces");
          if (iface && Array.isArray(res.data)) {
            res = { ...res, data: res.data.filter((e) => e && e.interface === iface) };
          }
        } else if (action === "start" && address) {
          // Serial-targeted pairing window bound to one device address.
          const body = {};
          if (seconds > 0) body.seconds = seconds;
          res = await client.post(`/devices/${encodeURIComponent(address)}/install-mode`, body);
        } else if (action === "start" || action === "stop") {
          if (!iface) {
            done(new Error("interface is required (config or msg.interface); msg.address opens a device-targeted window instead"));
            return;
          }
          const body = { interface: iface, active: action === "start" };
          if (action === "start" && seconds > 0) body.seconds = seconds;
          res = await client.post("/install-mode/interfaces", body);
        } else {
          done(new Error(`unknown action: ${action}`));
          return;
        }
        msg.payload = res.data ?? { status: res.status };
        msg.statusCode = res.status;
        node.status({ fill: "green", shape: "dot", text: `OK (${res.status})` });
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "error" });
        done(new Error(describeError(err)));
      }
    });
  }

  RED.nodes.registerType("openccu-loom-install-mode", OpenccuLoomInstallModeNode);
};
