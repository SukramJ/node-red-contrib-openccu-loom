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
          msg.payload = res.data ?? { status: res.status };
        } else if (mode === "get") {
          // No single-program endpoint exists; the daemon only exposes
          // GET /programs (list). Fetch the list and pick the entry by id.
          res = await client.get("/programs");
          const list = Array.isArray(res.data) ? res.data : [];
          const program = list.find((p) => p && String(p.id) === String(id));
          if (!program) {
            done(new Error(`program not found: ${id}`));
            return;
          }
          msg.payload = program;
        } else if (mode === "execute") {
          res = await client.post(`/programs/${encodeURIComponent(id)}/execute`);
          msg.payload = res.data ?? { status: res.status };
        } else {
          done(new Error(`unknown mode: ${mode}`));
          return;
        }
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
