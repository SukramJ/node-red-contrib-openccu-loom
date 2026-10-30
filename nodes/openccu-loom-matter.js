"use strict";

const { createClient, describeError } = require("../lib/client");

// Read-only scopes: an action name mapped straight onto its GET path, with
// no parameters and no body. Everything that mutates is spelled out in the
// switch below instead. Since API 14 the daemon serves the Matter node's
// routes under /node/… (go-fabric-ui's contract).
const READS = {
  status: "/node/status",
  compatibility: "/node/compatibility",
  endpoints: "/node/endpoints",
  mdns: "/node/mdns",
  sessions: "/node/sessions",
  events: "/node/events",
  fabrics: "/node/fabrics",
  exposure: "/node/exposure",
  // Both read the pairing codes: of the window the daemon opened while it is
  // open, else the configured ones, with `window_open` telling which.
  "setup-payload": "/node/pairing",
  "commissioning-window": "/node/pairing",
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
      // defaults to 900s and range-checks 180…900 itself. The body is
      // required — the daemon refuses an empty one — so without a duration
      // the node sends an empty object.
      const windowBody = () => {
        const body = payloadObject();
        if (body) return body;
        const seconds = pick("durationSeconds");
        return seconds != null ? { duration_seconds: Number(seconds) } : {};
      };
      // The exposure writes take a batch of item changes ({key, enabled,
      // name?}, keys as GET /node/exposure lists them). A bare array or a
      // single item is wrapped in `items`.
      const exposureBody = () => {
        if (Array.isArray(msg.payload)) return { items: msg.payload };
        const body = payloadObject();
        if (!body) return null;
        if (Array.isArray(body.items)) return body;
        return typeof body.key === "string" ? { items: [body] } : null;
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
              res = await client.post("/node/maintenance/reassemble");
              break;

            // --- fabrics --------------------------------------------------
            case "fabric-delete": {
              const id = pick("fabricId");
              if (id == null) return done(new Error("msg.fabricId missing"));
              res = await client.delete(`/node/fabrics/${encodeURIComponent(id)}`);
              break;
            }
            case "factory-reset":
              // Destructive: removes every commissioned fabric, so every
              // controller has to re-pair afterwards.
              res = await client.post("/node/maintenance/factory-reset", { confirm: FACTORY_RESET_CONFIRM });
              break;

            // --- exposure -------------------------------------------------
            case "exposure-set":
            case "exposure-preview": {
              const body = exposureBody();
              if (!body) {
                return done(
                  new Error(
                    `${action} needs msg.payload as an item {key, enabled, name?}, an array of them, or an object with an \`items\` array`
                  )
                );
              }
              res =
                action === "exposure-set"
                  ? await client.put("/node/exposure", body)
                  : await client.post("/node/exposure/preview", body);
              break;
            }

            // --- commissioning --------------------------------------------
            case "commissioning-open":
            case "share":
              // The daemon has one window verb since API 14; sharing the
              // bridge with another ecosystem opens the same window. Whether
              // it runs on the configured or on fresh credentials is the
              // daemon's setting, and the response carries the codes either
              // way.
              res = await client.post("/node/pairing/window", windowBody());
              break;
            case "commissioning-close":
              res = await client.post("/node/pairing/window/close");
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
