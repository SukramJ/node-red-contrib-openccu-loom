"use strict";

const { createClient, describeError } = require("../lib/client");

module.exports = function (RED) {
  function OpenccuLoomGroupsNode(config) {
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
      const id = msg.groupId != null && msg.groupId !== "" ? msg.groupId : config.groupId;
      // Every group route is per-central; omitted, the daemon applies its
      // own default (the single configured central, or its config default).
      const central = msg.central || config.central || undefined;
      const params = central ? { central } : undefined;
      const needsId = () => {
        if (id != null && id !== "") return false;
        done(new Error("msg.groupId missing"));
        return true;
      };
      // create/update take the whole request body from msg.payload; the
      // individual msg fields below are the convenience path for flows
      // that would otherwise have to build the object in a function node.
      const body = (fields) => {
        if (msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)) return msg.payload;
        const out = {};
        for (const [field, value] of Object.entries(fields)) {
          if (value != null && value !== "") out[field] = value;
        }
        return out;
      };

      node.status({ fill: "yellow", shape: "ring", text: action });
      try {
        let res;
        switch (action) {
          case "list":
            res = await client.get("/groups", params ? { params } : undefined);
            break;
          case "types":
            res = await client.get("/groups/types", params ? { params } : undefined);
            break;
          case "suitable-members": {
            const typeId = msg.typeId || config.typeId;
            if (!typeId) return done(new Error("msg.typeId missing (the group type to assign members to)"));
            res = await client.get("/groups/suitable-members", { params: { ...(params || {}), type_id: typeId } });
            break;
          }
          case "create": {
            const payload = body({
              type_id: msg.typeId || config.typeId,
              name: msg.groupName || config.groupName,
              forbid_single_operation: msg.forbidSingleOperation,
              members: msg.members,
            });
            if (!payload.type_id || !payload.name) {
              return done(new Error("create needs msg.typeId and msg.groupName (or a complete object msg.payload)"));
            }
            res = await client.post("/groups", payload, params ? { params } : undefined);
            break;
          }
          case "update": {
            if (needsId()) return;
            const payload = body({
              name: msg.groupName || config.groupName,
              forbid_single_operation: msg.forbidSingleOperation,
              members: msg.members,
            });
            if (!payload.name) {
              return done(new Error("update needs msg.groupName (or a complete object msg.payload)"));
            }
            res = await client.put(`/groups/${encodeURIComponent(id)}`, payload, params ? { params } : undefined);
            break;
          }
          case "delete":
            if (needsId()) return;
            res = await client.delete(`/groups/${encodeURIComponent(id)}`, params ? { params } : undefined);
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

  RED.nodes.registerType("openccu-loom-groups", OpenccuLoomGroupsNode);
};
