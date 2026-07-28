"use strict";

const { createClient, describeError } = require("../lib/client");

module.exports = function (RED) {
  function OpenccuLoomSysvarNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    if (!server) {
      node.status({ fill: "red", shape: "ring", text: "no server" });
      return;
    }
    const client = createClient(server);

    node.on("input", async (msg, send, done) => {
      const name = msg.sysvar || config.sysvar;
      const mode = msg.mode || config.mode || "read";
      if (!name && mode !== "list") {
        done(new Error("sysvar name missing"));
        return;
      }

      node.status({ fill: "yellow", shape: "ring", text: mode });
      try {
        let res;
        switch (mode) {
          case "list":
            res = await client.get("/sysvars");
            break;
          case "read":
            res = await client.get(`/sysvars/${encodeURIComponent(name)}`);
            break;
          case "usage": {
            // The programs referencing this variable — read-only, so a
            // sysvar can be checked before it is renamed or deleted.
            const central = msg.central || config.central;
            res = await client.get(
              `/sysvars/${encodeURIComponent(name)}/usage`,
              central ? { params: { central } } : undefined
            );
            break;
          }
          case "write":
            res = await client.put(`/sysvars/${encodeURIComponent(name)}`, {
              value: msg.payload,
            });
            break;
          case "create": {
            const body = typeof msg.payload === "object" && msg.payload
              ? msg.payload
              : { name };
            if (!body.name) body.name = name;
            res = await client.post("/sysvars", body);
            break;
          }
          case "patch": {
            const body = typeof msg.payload === "object" && msg.payload ? msg.payload : {};
            res = await client.patch(`/sysvars/${encodeURIComponent(name)}`, body);
            break;
          }
          case "delete":
            res = await client.delete(`/sysvars/${encodeURIComponent(name)}`);
            break;
          default:
            done(new Error(`unknown mode: ${mode}`));
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

  RED.nodes.registerType("openccu-loom-sysvar", OpenccuLoomSysvarNode);
};
