"use strict";

const { createClient, describeError } = require("../lib/client");

module.exports = function (RED) {
  function OpenccuLoomLinksNode(config) {
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
      const central = msg.central || config.central || undefined;

      node.status({ fill: "yellow", shape: "ring", text: action });
      try {
        let res;
        if (action === "list") {
          // Global direct-link overview; `locale` steers the language of
          // the human-readable channel labels in the reply.
          const params = {};
          if (central) params.central = central;
          const locale = msg.locale || config.locale;
          if (locale) params.locale = locale;
          res = await client.get("/links", Object.keys(params).length ? { params } : undefined);
        } else if (action === "test") {
          // Activates the link paramset at the device so the actuator
          // reacts once — the CCU WebUI's link "test" button.
          const addr = msg.address || config.address;
          const sender = msg.senderAddress || config.senderAddress;
          const receiver = msg.receiverAddress || config.receiverAddress;
          if (!addr) return done(new Error("address missing (the device the link is tested at)"));
          if (!sender || !receiver) {
            return done(new Error("test needs msg.senderAddress and msg.receiverAddress"));
          }
          const body = { sender_address: sender, receiver_address: receiver };
          const longPress = msg.longPress != null ? msg.longPress : config.longPress;
          if (longPress) body.long_press = true;
          res = await client.post(`/devices/${encodeURIComponent(addr)}/links/test`, body);
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

  RED.nodes.registerType("openccu-loom-links", OpenccuLoomLinksNode);
};
