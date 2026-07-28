"use strict";

const { createClient, describeError } = require("../lib/client");

module.exports = function (RED) {
  function OpenccuLoomCentralsNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    if (!server) {
      node.status({ fill: "red", shape: "ring", text: "no server" });
      return;
    }
    const client = createClient(server);

    node.on("input", async (msg, send, done) => {
      const action = msg.action || config.action || "list";
      const name = msg.centralName || config.centralName;

      node.status({ fill: "yellow", shape: "ring", text: action });
      try {
        let res;
        switch (action) {
          case "list":
            res = await client.get("/centrals");
            break;
          case "get":
            if (!name) return done(new Error("centralName missing"));
            res = await client.get(`/centrals/${encodeURIComponent(name)}`);
            break;
          case "create":
            res = await client.post("/centrals", msg.payload || {});
            break;
          case "update":
            if (!name) return done(new Error("centralName missing"));
            res = await client.put(`/centrals/${encodeURIComponent(name)}`, msg.payload || {});
            break;
          case "delete":
            if (!name) return done(new Error("centralName missing"));
            res = await client.delete(`/centrals/${encodeURIComponent(name)}`);
            break;
          case "reboot":
            // Reboots the CCU itself (admin), not the daemon; the daemon
            // answers 202 and the CCU goes away for a while.
            if (!name) return done(new Error("centralName missing"));
            res = await client.post(`/system/ccu/${encodeURIComponent(name)}/reboot`);
            break;
          default:
            return done(new Error(`unknown action: ${action}`));
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

  RED.nodes.registerType("openccu-loom-centrals", OpenccuLoomCentralsNode);
};
