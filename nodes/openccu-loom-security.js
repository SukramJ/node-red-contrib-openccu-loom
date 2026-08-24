"use strict";

const { createClient, describeError } = require("../lib/client");

// The hazard/fault classes the daemon classifies data points into. Used
// only to reject a typo before it reaches the daemon as an empty filter.
const CLASSES = new Set([
  "smoke",
  "water",
  "gas",
  "co",
  "tamper",
  "battery",
  "technical",
  "intrusion",
  "panic",
]);

// Query filters of GET /security/sources, in the spelling the daemon
// expects. `relevant` and `active` are flag-shaped: the daemon accepts the
// literal "true" only, so they are sent as flags rather than booleans.
const SOURCE_FILTERS = ["class", "central", "zone_id"];
const SOURCE_FLAGS = ["relevant", "active"];

module.exports = function (RED) {
  function OpenccuLoomSecurityNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    if (!server) {
      node.status({ fill: "red", shape: "ring", text: "no server" });
      return;
    }
    const client = createClient(server);

    node.on("input", async (msg, send, done) => {
      const action = msg.action || config.action || "state";
      // msg wins over the node's configured field; empty strings count as
      // unset so a cleared editor field falls through rather than being sent.
      const pick = (key) => {
        const m = msg[key];
        if (m != null && m !== "") return m;
        const c = config[key];
        return c != null && c !== "" ? c : null;
      };
      const cls = pick("class");
      const faultId = pick("faultId");
      const ref = pick("ref");

      node.status({ fill: "yellow", shape: "ring", text: action });
      try {
        let res;
        switch (action) {
          case "state":
            res = await client.get("/security");
            break;

          case "class": {
            if (!cls) return done(new Error("msg.class missing"));
            if (!CLASSES.has(cls)) {
              return done(new Error(`unknown class: ${cls} (expected one of ${[...CLASSES].join(", ")})`));
            }
            res = await client.get(`/security/classes/${encodeURIComponent(cls)}`);
            break;
          }

          case "faults":
            res = await client.get("/security/faults");
            break;
          case "fault-acknowledge":
            if (!faultId) return done(new Error("msg.faultId missing"));
            res = await client.post(`/security/faults/${encodeURIComponent(faultId)}/acknowledge`);
            break;

          case "sources": {
            const params = {};
            for (const key of SOURCE_FILTERS) {
              const value = key === "class" ? cls : msg[key] != null && msg[key] !== "" ? msg[key] : config[key];
              if (value != null && value !== "") params[key] = value;
            }
            if (params.class && !CLASSES.has(params.class)) {
              return done(new Error(`unknown class: ${params.class} (expected one of ${[...CLASSES].join(", ")})`));
            }
            for (const key of SOURCE_FLAGS) {
              const value = msg[key] != null ? msg[key] : config[key];
              // The daemon's enum has "true" as its only member, so the flag
              // is either present as "true" or left off entirely.
              if (value === true || value === "true") params[key] = "true";
            }
            res = await client.get("/security/sources", Object.keys(params).length ? { params } : undefined);
            break;
          }

          case "source-override": {
            if (!ref) return done(new Error("msg.ref missing"));
            const body =
              msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) ? msg.payload : null;
            if (!body) {
              return done(new Error("source-override needs an object msg.payload (class, included, note)"));
            }
            if (body.class != null && body.class !== "" && !CLASSES.has(body.class)) {
              return done(new Error(`unknown class: ${body.class} (expected one of ${[...CLASSES].join(", ")})`));
            }
            res = await client.put(`/security/sources/${encodeURIComponent(ref)}`, body);
            break;
          }

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

  RED.nodes.registerType("openccu-loom-security", OpenccuLoomSecurityNode);
};
