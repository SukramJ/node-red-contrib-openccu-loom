"use strict";

const { createClient, describeError } = require("../lib/client");

module.exports = function (RED) {
  function OpenccuLoomAreasNode(config) {
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
      const areaId = msg.areaId != null && msg.areaId !== "" ? msg.areaId : config.areaId;
      const needsArea = () => {
        if (areaId != null && areaId !== "") return false;
        done(new Error("msg.areaId missing"));
        return true;
      };
      const payloadObject = () =>
        msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) ? msg.payload : null;

      node.status({ fill: "yellow", shape: "ring", text: action });
      try {
        let res;
        switch (action) {
          case "list":
            res = await client.get("/areas");
            break;
          case "create": {
            const body = payloadObject();
            // The daemon generates the id and ignores one sent in the body,
            // so only the name is worth insisting on here.
            if (!body || !body.name) {
              return done(new Error("create needs an object msg.payload with at least {name}"));
            }
            res = await client.post("/areas", body);
            break;
          }
          case "update": {
            if (needsArea()) return;
            const body = payloadObject();
            if (!body || !body.id || !body.name) {
              return done(new Error("update needs an object msg.payload with at least {id, name}"));
            }
            res = await client.put(`/areas/${encodeURIComponent(areaId)}`, body);
            break;
          }
          case "delete":
            // Removes the area and clears its room assignments; the rooms
            // themselves stay on their central.
            if (needsArea()) return;
            res = await client.delete(`/areas/${encodeURIComponent(areaId)}`);
            break;
          case "rooms-set":
            if (needsArea()) return;
            // A replace, not a merge: the array is the complete room set, and
            // an empty one clears the area.
            if (!Array.isArray(msg.payload)) {
              return done(new Error("rooms-set needs an array msg.payload of {central, room} objects"));
            }
            res = await client.put(`/areas/${encodeURIComponent(areaId)}/rooms`, msg.payload);
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

  RED.nodes.registerType("openccu-loom-areas", OpenccuLoomAreasNode);
};
