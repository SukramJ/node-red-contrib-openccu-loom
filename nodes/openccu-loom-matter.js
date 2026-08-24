"use strict";

const { createClient, describeError } = require("../lib/client");

// Read-only scopes: an action name mapped straight onto its GET path, with
// no parameters and no body. Everything that mutates is spelled out in the
// switch below instead.
const READS = {
  status: "/matter/status",
  compatibility: "/matter/compatibility",
  endpoints: "/matter/endpoints",
  mdns: "/matter/mdns",
  sessions: "/matter/sessions",
  events: "/matter/events",
  fabrics: "/matter/fabrics",
  exposable: "/matter/exposable",
  "setup-payload": "/matter/setup-payload",
  "commissioning-window": "/matter/commissioning/window",
};

// The daemon only accepts this literal as the factory-reset confirmation;
// anything else is a 400, so the node fills it in rather than making every
// flow carry the magic string.
const FACTORY_RESET_CONFIRM = "remove-all-fabrics";

module.exports = function (RED) {
  function OpenccuLoomMatterNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    if (!server) {
      node.status({ fill: "red", shape: "ring", text: "no server" });
      return;
    }
    const client = createClient(server);

    node.on("input", async (msg, send, done) => {
      const action = msg.action || config.action || "status";
      const pick = (key) => {
        const m = msg[key];
        if (m != null && m !== "") return m;
        const c = config[key];
        return c != null && c !== "" ? c : null;
      };
      const payloadObject = () =>
        msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) ? msg.payload : null;
      // Both window verbs take the same optional duration; the daemon
      // defaults to 900s and range-checks 180…900 itself.
      const windowBody = () => {
        const body = payloadObject();
        if (body) return body;
        const seconds = pick("durationSeconds");
        return seconds != null ? { duration_seconds: Number(seconds) } : undefined;
      };

      node.status({ fill: "yellow", shape: "ring", text: action });
      try {
        let res;
        if (READS[action]) {
          res = await client.get(READS[action]);
        } else {
          switch (action) {
            // --- topology -------------------------------------------------
            case "force-sync":
              res = await client.post("/matter/force-sync");
              break;

            // --- fabrics --------------------------------------------------
            case "fabric-delete": {
              const id = pick("fabricId");
              if (id == null) return done(new Error("msg.fabricId missing"));
              res = await client.delete(`/matter/fabrics/${encodeURIComponent(id)}`);
              break;
            }
            case "factory-reset":
              // Destructive: removes every commissioned fabric, so every
              // controller has to re-pair afterwards.
              res = await client.post("/matter/factory-reset", { confirm: FACTORY_RESET_CONFIRM });
              break;

            // --- allowlist ------------------------------------------------
            case "exposable-set": {
              const body = payloadObject();
              if (!body) {
                return done(
                  new Error(
                    "exposable-set needs an object msg.payload (central_name, device_address, channel_no, dp_kind, dp_key, enabled)"
                  )
                );
              }
              res = await client.put("/matter/exposable", body);
              break;
            }
            case "exposable-bulk": {
              // Callers may hand over the bare array of rows; the daemon
              // wants it wrapped in `items`.
              const body = Array.isArray(msg.payload) ? { items: msg.payload } : payloadObject();
              if (!body || !Array.isArray(body.items)) {
                return done(new Error("exposable-bulk needs an array msg.payload, or an object with an `items` array"));
              }
              res = await client.post("/matter/exposable/bulk", body);
              break;
            }

            // --- commissioning --------------------------------------------
            case "commissioning-open":
              res = await client.post("/matter/commissioning/window", windowBody());
              break;
            case "commissioning-close":
              res = await client.post("/matter/commissioning/window/close");
              break;
            case "share":
              // Same window verb, but for handing the bridge to a second
              // ecosystem rather than the first one.
              res = await client.post("/matter/share", windowBody());
              break;

            default:
              return done(new Error(`unknown action: ${action}`));
          }
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

  RED.nodes.registerType("openccu-loom-matter", OpenccuLoomMatterNode);
};
