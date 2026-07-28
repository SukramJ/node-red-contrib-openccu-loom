"use strict";

const { createClient, describeError } = require("../lib/client");

// Capability token the daemon advertises in GET /api/v1/info once the
// alarm engine is compiled in; without it every /alarm route answers 404.
const ALARM_CAPABILITY = "alarm.v1";

// Optional query filters of GET /alarm/journal, in the spelling the
// daemon expects. `zone` is the zone id, `class` one of
// arm|disarm|trigger|silence|bypass|fault|test|config.
const JOURNAL_PARAMS = ["zone", "class", "from", "to", "limit"];

module.exports = function (RED) {
  function OpenccuLoomAlarmAdminNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    if (!server) {
      node.status({ fill: "red", shape: "ring", text: "no server" });
      return;
    }
    const client = createClient(server);

    // Advisory only, same contract as the alarm node: a daemon without the
    // alarm engine gets a yellow hint at deploy, calls still go through and
    // surface the daemon's own 404 at call time.
    server
      .hasCapability(ALARM_CAPABILITY)
      .then((ok) => {
        if (!ok) node.status({ fill: "yellow", shape: "ring", text: `${ALARM_CAPABILITY} not available` });
      })
      .catch(() => {
        /* advisory only */
      });

    node.on("input", async (msg, send, done) => {
      const action = msg.action || config.action || "state";
      const zoneId = msg.zoneId != null && msg.zoneId !== "" ? msg.zoneId : config.zoneId;
      const codeId = msg.codeId != null && msg.codeId !== "" ? msg.codeId : config.codeId;
      const outputId = msg.outputId != null && msg.outputId !== "" ? msg.outputId : config.outputId;
      const needsZone = () => {
        if (zoneId != null && zoneId !== "") return false;
        done(new Error("msg.zoneId missing"));
        return true;
      };
      const needsCode = () => {
        if (codeId != null && codeId !== "") return false;
        done(new Error("msg.codeId missing"));
        return true;
      };
      // Write bodies come from msg.payload; the arm/verb helpers below
      // assemble theirs from the individual fields instead, mirroring the
      // WebSocket alarm node's inputs.
      const payloadObject = () =>
        msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) ? msg.payload : null;
      const codeBody = () => {
        const body = {};
        const code = msg.code != null ? msg.code : config.code;
        if (code != null && code !== "") body.code = code;
        return Object.keys(body).length ? body : undefined;
      };

      node.status({ fill: "yellow", shape: "ring", text: action });
      try {
        let res;
        switch (action) {
          // --- live status -------------------------------------------
          case "state":
            res = await client.get("/alarm/state");
            break;
          case "panels":
            res = await client.get("/alarm/panels");
            break;
          case "journal": {
            const params = {};
            for (const name of JOURNAL_PARAMS) {
              const value = msg[name] != null ? msg[name] : config[name];
              if (value != null && value !== "") params[name] = value;
            }
            res = await client.get("/alarm/journal", Object.keys(params).length ? { params } : undefined);
            break;
          }
          case "readiness":
            if (needsZone()) return;
            res = await client.get(`/alarm/zones/${encodeURIComponent(zoneId)}/readiness`);
            break;

          // --- zone configuration -------------------------------------
          case "zones":
            res = await client.get("/alarm/zones");
            break;
          case "zone":
            if (needsZone()) return;
            res = await client.get(`/alarm/zones/${encodeURIComponent(zoneId)}`);
            break;
          case "zone-create": {
            const body = payloadObject();
            if (!body || !body.id || !body.name) {
              return done(new Error("zone-create needs an object msg.payload with at least {id, name}"));
            }
            res = await client.post("/alarm/zones", body);
            break;
          }
          case "zone-update": {
            if (needsZone()) return;
            const body = payloadObject();
            if (!body || !body.id || !body.name) {
              return done(new Error("zone-update needs an object msg.payload with at least {id, name}"));
            }
            res = await client.put(`/alarm/zones/${encodeURIComponent(zoneId)}`, body);
            break;
          }
          case "zone-delete":
            if (needsZone()) return;
            res = await client.delete(`/alarm/zones/${encodeURIComponent(zoneId)}`);
            break;

          // --- sensors / outputs --------------------------------------
          case "sensors":
            if (needsZone()) return;
            res = await client.get(`/alarm/zones/${encodeURIComponent(zoneId)}/sensors`);
            break;
          case "sensors-set":
            if (needsZone()) return;
            // The PUT replaces the whole enrolment set, so an array is the
            // only meaningful body — an empty one unenrols every sensor.
            if (!Array.isArray(msg.payload)) {
              return done(new Error("sensors-set needs msg.payload to be the full array of sensor rows"));
            }
            res = await client.put(`/alarm/zones/${encodeURIComponent(zoneId)}/sensors`, msg.payload);
            break;
          case "outputs":
            if (needsZone()) return;
            res = await client.get(`/alarm/zones/${encodeURIComponent(zoneId)}/outputs`);
            break;
          case "outputs-set":
            if (needsZone()) return;
            if (!Array.isArray(msg.payload)) {
              return done(new Error("outputs-set needs msg.payload to be the full array of output rows"));
            }
            res = await client.put(`/alarm/zones/${encodeURIComponent(zoneId)}/outputs`, msg.payload);
            break;
          case "output-candidates": {
            // Narrowing by output class (acoustic_siren, alarm_light, …) is
            // optional; without it the daemon returns every candidate.
            const cls = msg.class || config.class;
            res = await client.get("/alarm/output-candidates", cls ? { params: { class: cls } } : undefined);
            break;
          }
          case "remote-key-candidates":
            res = await client.get("/alarm/remote-key-candidates");
            break;
          case "output-test": {
            if (outputId == null || outputId === "") return done(new Error("msg.outputId missing"));
            const opticalOnly = msg.opticalOnly != null ? msg.opticalOnly : config.opticalOnly;
            const body = opticalOnly ? { optical_only: true } : undefined;
            res = await client.post(`/alarm/outputs/${encodeURIComponent(outputId)}/test`, body);
            break;
          }

          // --- codes ---------------------------------------------------
          case "codes":
            res = await client.get("/alarm/codes");
            break;
          case "code":
            if (needsCode()) return;
            res = await client.get(`/alarm/codes/${encodeURIComponent(codeId)}`);
            break;
          case "code-create": {
            const body = payloadObject();
            if (!body) return done(new Error("code-create needs an object msg.payload (name, kind, perms, enabled)"));
            res = await client.post("/alarm/codes", body);
            break;
          }
          case "code-update": {
            if (needsCode()) return;
            const body = payloadObject();
            if (!body) return done(new Error("code-update needs an object msg.payload (name, kind, perms, enabled)"));
            res = await client.put(`/alarm/codes/${encodeURIComponent(codeId)}`, body);
            break;
          }
          case "code-delete":
            if (needsCode()) return;
            res = await client.delete(`/alarm/codes/${encodeURIComponent(codeId)}`);
            break;

          // --- walk test ------------------------------------------------
          case "walktest":
            if (needsZone()) return;
            res = await client.get(`/alarm/zones/${encodeURIComponent(zoneId)}/walktest`);
            break;
          case "walktest-start":
            if (needsZone()) return;
            res = await client.post(`/alarm/zones/${encodeURIComponent(zoneId)}/walktest/start`);
            break;
          case "walktest-stop":
            if (needsZone()) return;
            res = await client.post(`/alarm/zones/${encodeURIComponent(zoneId)}/walktest/stop`);
            break;

          // --- operating a zone over REST -------------------------------
          case "arm": {
            if (needsZone()) return;
            const mode = msg.mode || config.mode;
            if (!mode) return done(new Error("msg.mode missing for arm"));
            const body = payloadObject() || { mode };
            if (!payloadObject()) {
              for (const [field, value] of [
                ["force", msg.force],
                ["skip_delay", msg.skip_delay != null ? msg.skip_delay : msg.skipDelay],
                ["bypass", msg.bypass],
                ["code", msg.code != null ? msg.code : config.code],
              ]) {
                if (value != null && value !== "") body[field] = value;
              }
            }
            res = await client.post(`/alarm/zones/${encodeURIComponent(zoneId)}/arm`, body);
            break;
          }
          case "disarm":
            if (needsZone()) return;
            res = await client.post(`/alarm/zones/${encodeURIComponent(zoneId)}/disarm`, codeBody());
            break;
          case "silence":
            if (needsZone()) return;
            res = await client.post(`/alarm/zones/${encodeURIComponent(zoneId)}/silence`, codeBody());
            break;
          case "acknowledge":
            if (needsZone()) return;
            res = await client.post(`/alarm/zones/${encodeURIComponent(zoneId)}/acknowledge`, codeBody());
            break;
          case "silence-all":
            res = await client.post("/alarm/silence-all");
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

  RED.nodes.registerType("openccu-loom-alarm-admin", OpenccuLoomAlarmAdminNode);
};
