"use strict";

const { createClient, describeError, mergeIdempotency } = require("../lib/client");

// Body fields the daemon accepts on both POST /devices/{addr}/accept and
// PATCH /devices/{addr} — first-time configuration applied right after the
// accept, and the same fields as a plain rename/assignment later on.
const DEVICE_CONFIG_FIELDS = ["name", "include_channels", "rooms", "functions"];

// Assembles a body from msg.payload (an object wins as a whole) or from the
// individual msg fields, dropping empty values so an omitted field leaves
// the CCU metadata untouched.
function configBody(msg, fields) {
  if (msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)) return msg.payload;
  const body = {};
  for (const field of fields) {
    // include_channels -> msg.includeChannels, rooms -> msg.rooms, ...
    const camel = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const value = msg[camel] != null ? msg[camel] : msg[field];
    if (value != null && value !== "") body[field] = value;
  }
  return body;
}

// Truthy-ish query flags: only sent when explicitly set, so the daemon's
// own defaults (both false) stay in charge otherwise.
function flagParams(msg, config, names) {
  const params = {};
  for (const name of names) {
    const value = msg[name] != null ? msg[name] : config[name];
    if (value != null && value !== "" && value !== false) params[name] = true;
  }
  return params;
}

module.exports = function (RED) {
  function OpenccuLoomDeviceAdminNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    if (!server) {
      node.status({ fill: "red", shape: "ring", text: "no server" });
      return;
    }
    const client = createClient(server);

    node.on("input", async (msg, send, done) => {
      const action = msg.action || config.action || "refresh";
      const addr = msg.address || config.address;
      const central = msg.central || config.central || undefined;
      const channel = msg.channel != null && msg.channel !== "" ? msg.channel : config.channel;
      const needsAddress = () => {
        if (addr) return false;
        done(new Error("address missing"));
        return true;
      };
      const needsChannel = () => {
        if (channel != null && channel !== "") return false;
        done(new Error("channel missing"));
        return true;
      };
      // Every path below is spelled out as a full template literal rather
      // than assembled from a base-path helper: test/api-surface.test.js
      // scans this file for path literals and can only pin the ones that
      // start with "/".

      node.status({ fill: "yellow", shape: "ring", text: action });
      try {
        let res;
        switch (action) {
          case "batch":
            if (!Array.isArray(msg.payload)) {
              return done(new Error("msg.payload must be an array of {address, channel, parameter, value, priority?}"));
            }
            res = await client.post("/devices/values:batch", { values: msg.payload }, {
              headers: mergeIdempotency(undefined, msg),
            });
            break;
          case "refresh":
            res = await client.post("/devices/refresh");
            break;
          case "accept": {
            if (needsAddress()) return;
            // An empty body accepts the device unconfigured; name / rooms /
            // functions / include_channels apply first-time configuration
            // right after the accept succeeds.
            const body = configBody(msg, DEVICE_CONFIG_FIELDS);
            res = await client.post(`/devices/${encodeURIComponent(addr)}/accept`, Object.keys(body).length ? body : undefined);
            break;
          }
          case "rename": {
            if (needsAddress()) return;
            const body = configBody(msg, DEVICE_CONFIG_FIELDS);
            if (!Object.keys(body).length) {
              return done(new Error("rename needs at least one of msg.name, msg.rooms, msg.functions (or an object msg.payload)"));
            }
            res = await client.patch(`/devices/${encodeURIComponent(addr)}`, body);
            break;
          }
          case "firmware":
            if (needsAddress()) return;
            res = await client.post(`/devices/${encodeURIComponent(addr)}/firmware/update`);
            break;
          case "firmware-download": {
            const url = msg.url || config.url;
            if (!url) return done(new Error("msg.url missing (firmware image URL)"));
            res = await client.post("/system/firmware/download", central ? { url, central } : { url });
            break;
          }
          case "delete":
            if (needsAddress()) return;
            // reset also factory-resets the device, force removes an
            // unreachable one; both default to a plain unpair.
            res = await client.delete(`/devices/${encodeURIComponent(addr)}`, { params: flagParams(msg, config, ["reset", "force"]) });
            break;
          case "test":
            if (needsAddress()) return;
            res = await client.post(`/devices/${encodeURIComponent(addr)}/test`);
            break;
          case "restore-config":
            if (needsAddress()) return;
            res = await client.post(`/devices/${encodeURIComponent(addr)}/config/restore`);
            break;
          case "replace-candidates":
            if (needsAddress()) return;
            res = await client.get(`/devices/${encodeURIComponent(addr)}/replace-candidates`, central ? { params: { central } } : undefined);
            break;
          case "replace": {
            if (needsAddress()) return;
            const oldAddress = msg.oldAddress || msg.old_address || config.oldAddress;
            if (!oldAddress) return done(new Error("msg.oldAddress missing (the device being replaced)"));
            const body = { old_address: oldAddress };
            if (central) body.central = central;
            res = await client.post(`/devices/${encodeURIComponent(addr)}/replace`, body);
            break;
          }
          case "channel-update": {
            if (needsAddress() || needsChannel()) return;
            const body = configBody(msg, ["name", "rooms", "functions"]);
            if (!Object.keys(body).length) {
              return done(new Error("channel-update needs at least one of msg.name, msg.rooms, msg.functions (or an object msg.payload)"));
            }
            res = await client.patch(`/devices/${encodeURIComponent(addr)}/channels/${encodeURIComponent(channel)}`, body);
            break;
          }
          case "channel-flags":
            if (needsAddress() || needsChannel()) return;
            res = await client.get(`/devices/${encodeURIComponent(addr)}/channels/${encodeURIComponent(channel)}/flags`);
            break;
          case "channel-flags-set": {
            if (needsAddress() || needsChannel()) return;
            // Both flags are operator overrides (G12): hidden removes the
            // channel from the UI, locked blocks operating it.
            const body = {};
            for (const flag of ["hidden", "locked"]) {
              const value = msg[flag] != null ? msg[flag] : config[flag];
              if (value != null && value !== "") body[flag] = !!value;
            }
            if (!Object.keys(body).length) {
              return done(new Error("channel-flags-set needs msg.hidden and/or msg.locked"));
            }
            res = await client.put(`/devices/${encodeURIComponent(addr)}/channels/${encodeURIComponent(channel)}/flags`, body);
            break;
          }
          case "team-candidates":
            if (needsAddress() || needsChannel()) return;
            res = await client.get(`/devices/${encodeURIComponent(addr)}/channels/${encodeURIComponent(channel)}/team-candidates`);
            break;
          case "team-set": {
            if (needsAddress() || needsChannel()) return;
            // An empty team detaches the channel from its current team.
            const team = msg.team != null ? msg.team : config.team;
            res = await client.put(`/devices/${encodeURIComponent(addr)}/channels/${encodeURIComponent(channel)}/team`, { team: team || "" });
            break;
          }
          default:
            return done(new Error(`unknown action: ${action}`));
        }
        msg.payload = res.data ?? { status: res.status };
        msg.statusCode = res.status;
        if (res.headers && res.headers["idempotent-replay"]) msg.idempotentReplay = true;
        node.status({ fill: "green", shape: "dot", text: `OK (${res.status})` });
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "error" });
        done(new Error(describeError(err)));
      }
    });
  }

  RED.nodes.registerType("openccu-loom-device-admin", OpenccuLoomDeviceAdminNode);
};
