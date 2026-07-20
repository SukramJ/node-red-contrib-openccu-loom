"use strict";

const { createClient, describeError } = require("../lib/client");

const PATHS = {
  info: "/info",
  health: "/health",
  config: "/config",
  "config-effective": "/config/effective",
  "config-schema": "/config/schema",
  ccu: "/system/ccu",
};

module.exports = function (RED) {
  function OpenccuLoomHealthNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    if (!server) {
      node.status({ fill: "red", shape: "ring", text: "no server" });
      return;
    }
    const client = createClient(server);

    node.on("input", async (msg, send, done) => {
      const scope = msg.scope || config.scope || "health";
      const path = PATHS[scope];
      if (!path) return done(new Error(`unknown scope: ${scope}`));

      node.status({ fill: "yellow", shape: "ring", text: scope });
      try {
        const res = await client.get(path);
        msg.payload = res.data;
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

  RED.nodes.registerType("openccu-loom-health", OpenccuLoomHealthNode);
};
