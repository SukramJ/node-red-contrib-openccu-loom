"use strict";

const { createClient, describeError } = require("../lib/client");

// The four coordinates that identify one data point for the recording
// override; all of them are required on both read and write.
const COORDS = [
  ["central", "central"],
  ["interfaceId", "interface_id"],
  ["channel", "channel"],
  ["parameter", "parameter"],
];

module.exports = function (RED) {
  function OpenccuLoomRecordingNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    if (!server) {
      node.status({ fill: "red", shape: "ring", text: "no server" });
      return;
    }
    const client = createClient(server);

    node.on("input", async (msg, send, done) => {
      const action = msg.action || config.action || "get";
      const coords = {};
      const missing = [];
      for (const [msgField, apiField] of COORDS) {
        // interface_id also accepts the snake_case msg spelling, so a
        // payload straight from the daemon can be piped back in.
        const value = msg[msgField] != null && msg[msgField] !== "" ? msg[msgField] : msg[apiField] || config[msgField];
        if (value == null || value === "") missing.push(msgField);
        else coords[apiField] = value;
      }
      if (missing.length) {
        done(new Error(`missing: ${missing.map((f) => `msg.${f}`).join(", ")}`));
        return;
      }

      node.status({ fill: "yellow", shape: "ring", text: action });
      try {
        let res;
        if (action === "get") {
          res = await client.get("/history/recording", { params: coords });
        } else if (action === "set") {
          // record omitted clears the override and hands the data point
          // back to the configured default (the reply's `source` says
          // which rule won).
          const record = msg.record != null ? msg.record : config.record;
          const body = { ...coords };
          if (record != null && record !== "") body.record = !!record;
          res = await client.put("/history/recording", body);
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

  RED.nodes.registerType("openccu-loom-recording", OpenccuLoomRecordingNode);
};
