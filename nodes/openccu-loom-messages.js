"use strict";

const { createClient, describeError } = require("../lib/client");

module.exports = function (RED) {
  function OpenccuLoomMessagesNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    if (!server) {
      node.status({ fill: "red", shape: "ring", text: "no server" });
      return;
    }
    const client = createClient(server);

    node.on("input", async (msg, send, done) => {
      const kind = msg.kind || config.kind || "alarm";
      const action = msg.action || config.action || "list";
      // config.id would be the flow-node id, never a message id.
      const id = msg.id;
      const base = kind === "service" ? "/service-messages" : "/alarm-messages";

      node.status({ fill: "yellow", shape: "ring", text: `${kind} ${action}` });
      try {
        let res;
        if (action === "list") {
          res = await client.get(base);
        } else if (action === "ack") {
          if (!id) return done(new Error("msg.id missing for ack"));
          res = await client.post(`${base}/${encodeURIComponent(id)}/ack`);
        } else {
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

  RED.nodes.registerType("openccu-loom-messages", OpenccuLoomMessagesNode);
};
