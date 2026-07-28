"use strict";

const { createClient, describeError } = require("../lib/client");

module.exports = function (RED) {
  function OpenccuLoomDiagramsNode(config) {
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
      const id = msg.diagramId != null && msg.diagramId !== "" ? msg.diagramId : config.diagramId;
      const needsId = () => {
        if (id != null && id !== "") return false;
        done(new Error("msg.diagramId missing"));
        return true;
      };
      // create/update send msg.payload verbatim when it is an object;
      // otherwise the request is assembled from the individual fields.
      const writeBody = () => {
        if (msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)) return msg.payload;
        const out = {};
        const diagramName = msg.diagramName || config.diagramName;
        const visibility = msg.visibility || config.visibility;
        if (diagramName) out.name = diagramName;
        if (visibility) out.visibility = visibility;
        if (msg.config != null) out.config = msg.config;
        return out;
      };

      node.status({ fill: "yellow", shape: "ring", text: action });
      try {
        let res;
        switch (action) {
          case "list":
            res = await client.get("/diagrams");
            break;
          case "get":
            if (needsId()) return;
            res = await client.get(`/diagrams/${encodeURIComponent(id)}`);
            break;
          case "create": {
            const body = writeBody();
            if (!body.name) return done(new Error("create needs msg.diagramName (or an object msg.payload with a name)"));
            res = await client.post("/diagrams", body);
            break;
          }
          case "update": {
            if (needsId()) return;
            const body = writeBody();
            if (!body.name) return done(new Error("update needs msg.diagramName (or an object msg.payload with a name)"));
            res = await client.put(`/diagrams/${encodeURIComponent(id)}`, body);
            break;
          }
          case "delete":
            if (needsId()) return;
            res = await client.delete(`/diagrams/${encodeURIComponent(id)}`);
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

  RED.nodes.registerType("openccu-loom-diagrams", OpenccuLoomDiagramsNode);
};
