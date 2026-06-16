"use strict";

const { createClient, describeError } = require("../lib/client");

module.exports = function (RED) {
  function OpenccuLoomProgramNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    if (!server) {
      node.status({ fill: "red", shape: "ring", text: "no server" });
      return;
    }
    const client = createClient(server);

    node.on("input", async (msg, send, done) => {
      const id = msg.programId || config.programId;
      const mode = msg.mode || config.mode || "execute";
      if (!id && mode !== "list") {
        done(new Error("programId missing"));
        return;
      }

      node.status({ fill: "yellow", shape: "ring", text: mode });
      try {
        let res;
        if (mode === "list") {
          res = await client.get("/programs");
        } else if (mode === "get") {
          res = await client.get(`/programs/${encodeURIComponent(id)}`);
        } else if (mode === "execute") {
          res = await client.post(`/programs/${encodeURIComponent(id)}/execute`);
        } else {
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

  RED.nodes.registerType("openccu-loom-program", OpenccuLoomProgramNode);
};
