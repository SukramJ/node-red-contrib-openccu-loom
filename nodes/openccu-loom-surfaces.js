"use strict";

const { createClient, describeError } = require("../lib/client");

// Where the "embedded" master toggle applies. The daemon rejects an
// unrecognised value rather than falling back to the default — a typo would
// otherwise keep hiding views on direct access, which is what the operator
// was switching off — so the node checks it first.
const SCOPES = new Set(["inside_ha", "always"]);

module.exports = function (RED) {
  function OpenccuLoomSurfacesNode(config) {
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

      node.status({ fill: "yellow", shape: "ring", text: action });
      try {
        let res;
        if (action === "get") {
          res = await client.get("/ui/surfaces");
        } else if (action === "set") {
          const body =
            msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) ? msg.payload : null;
          if (!body) {
            return done(new Error("set needs an object msg.payload (embedded, embedded_scope, profiles)"));
          }
          if (body.embedded_scope != null && body.embedded_scope !== "" && !SCOPES.has(body.embedded_scope)) {
            return done(
              new Error(`unknown embedded_scope: ${body.embedded_scope} (expected one of ${[...SCOPES].join(", ")})`)
            );
          }
          res = await client.put("/ui/surfaces", body);
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

  RED.nodes.registerType("openccu-loom-surfaces", OpenccuLoomSurfacesNode);
};
