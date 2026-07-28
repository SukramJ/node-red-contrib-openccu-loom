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
      // Every ack-all / suppression route is per-central; omitted, the
      // daemon applies its own default.
      const central = msg.central || config.central || undefined;
      const params = central ? { params: { central } } : undefined;

      node.status({ fill: "yellow", shape: "ring", text: `${kind} ${action}` });
      try {
        let res;
        if (action === "list") {
          res = await client.get(base);
        } else if (action === "ack") {
          if (!id) return done(new Error("msg.id missing for ack"));
          res = await client.post(`${base}/${encodeURIComponent(id)}/ack`);
        } else if (action === "ack-all") {
          // Alarm messages are acknowledged wholesale; on the service side
          // only the quittable ones are, and the reply counts them.
          res = await client.post(
            kind === "service" ? "/service-messages/ack-all" : "/alarm-messages/ack-all",
            undefined,
            params
          );
        } else if (action === "suppressed") {
          res = await client.get("/service-messages/suppressed");
        } else if (action === "unsuppress") {
          // The channel identifies the suppression; interface and
          // parameter narrow it when the same channel carries several.
          const channel = msg.channel || config.channel;
          if (!channel) return done(new Error("msg.channel missing for unsuppress"));
          const body = { channel };
          const iface = msg.interface || config.interface;
          const parameter = msg.parameter || config.parameter;
          if (iface) body.interface = iface;
          if (parameter) body.parameter = parameter;
          res = await client.post("/service-messages/unsuppress", body, params);
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
