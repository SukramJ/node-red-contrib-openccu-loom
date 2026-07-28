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
      // Both the list filter and the delete route are per-central; when
      // neither msg nor config names one, the daemon applies its own
      // default (the single configured central, or its config default).
      const central = msg.central || config.central || undefined;

      node.status({ fill: "yellow", shape: "ring", text: mode });
      try {
        let res;
        if (mode === "list") {
          // include_internal overrides the central's
          // `include_internal_programs` default (Tmp_*, prgEnergyCounter_*
          // are hidden unless asked for). Left unset, the daemon decides.
          const includeInternal = msg.includeInternal != null ? msg.includeInternal : config.includeInternal;
          const params = {};
          if (includeInternal != null && includeInternal !== "") params.include_internal = !!includeInternal;
          res = await client.get("/programs", Object.keys(params).length ? { params } : undefined);
        } else if (mode === "get") {
          res = await client.get(`/programs/${encodeURIComponent(id)}`);
        } else if (mode === "execute") {
          // check_conditions runs the program only when its "if" condition
          // currently holds; the reply reports `executed`.
          const checkConditions = msg.checkConditions != null ? msg.checkConditions : config.checkConditions;
          const body = checkConditions ? { check_conditions: true } : undefined;
          res = await client.post(`/programs/${encodeURIComponent(id)}/execute`, body);
        } else if (mode === "set-active") {
          // The CCU's own "program active" flag: an inactive program stays
          // in the registry but no longer runs on its own trigger.
          const active = msg.active != null ? msg.active : config.active;
          if (active == null || active === "") {
            done(new Error("msg.active missing (true|false) for set-active"));
            return;
          }
          res = await client.patch(`/programs/${encodeURIComponent(id)}`, { active: !!active });
        } else if (mode === "delete") {
          res = await client.delete(`/programs/${encodeURIComponent(id)}`, central ? { params: { central } } : undefined);
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
