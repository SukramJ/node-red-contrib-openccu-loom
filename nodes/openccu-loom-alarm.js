"use strict";

const { getHub, releaseHub } = require("../lib/ws-hub");

// Capability token the daemon advertises in GET /api/v1/info once the
// alarm engine is compiled in (see server.hasCapability in
// openccu-loom-server.js).
const ALARM_CAPABILITY = "alarm.v1";

// action -> wsapi command, mirrored verbatim from assets/wsapi.json
// (category "alarm_panel"). Exported so a contract test can pin the map.
const ALARM_COMMANDS = {
  state: "alarm_panel.state",
  panels: "alarm_panel.panels",
  readiness: "alarm_panel.readiness",
  journal: "alarm_panel.journal",
  walktest_status: "alarm_panel.walktest_status",
  arm: "alarm_panel.arm",
  disarm: "alarm_panel.disarm",
  silence: "alarm_panel.silence",
  silence_all: "alarm_panel.silence_all",
  acknowledge: "alarm_panel.acknowledge",
};

// The exact argument names each command accepts, taken verbatim from
// the wsapi.json command_schemas for "alarm_panel.*". `area_id` is the
// one argument every per-area action shares; msg.area_id, the shorter
// msg.panel alias, or the node's configured default panel feed it.
const ARG_NAMES = {
  "alarm_panel.arm": ["area_id", "mode", "force", "skip_delay", "bypass", "code"],
  "alarm_panel.disarm": ["area_id", "code"],
  "alarm_panel.silence": ["area_id", "code"],
  "alarm_panel.silence_all": [],
  "alarm_panel.acknowledge": ["area_id", "code"],
  "alarm_panel.state": [],
  "alarm_panel.readiness": ["area_id"],
  "alarm_panel.journal": ["area_id", "class", "from", "to", "limit"],
  "alarm_panel.walktest_status": ["area_id"],
  "alarm_panel.panels": [],
};

function buildArgs(command, config, msg) {
  const names = ARG_NAMES[command] || [];
  const args = {};
  for (const name of names) {
    let value;
    if (name === "area_id") {
      value = msg.area_id != null ? msg.area_id : msg.panel != null ? msg.panel : config.panel;
    } else {
      value = msg[name];
    }
    if (value != null && value !== "") args[name] = value;
  }
  // msg.args wins key-by-key over the fields assembled above.
  if (msg.args && typeof msg.args === "object") Object.assign(args, msg.args);
  return args;
}

module.exports = function (RED) {
  function OpenccuLoomAlarmNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    if (!server) {
      node.status({ fill: "red", shape: "ring", text: "no server" });
      return;
    }
    const hub = getHub(server);
    hub.addRef();

    const offStatus = hub.onStatus((s) => {
      if (typeof s === "object" && s && s.error) {
        node.status({ fill: "red", shape: "ring", text: "ws err" });
        return;
      }
      if (s === "open") node.status({ fill: "green", shape: "dot", text: "ready" });
      else if (s === "connecting") node.status({ fill: "yellow", shape: "ring", text: "connecting..." });
      else node.status({ fill: "red", shape: "ring", text: String(s) });
    });

    // Advisory only: an older daemon without the alarm engine gets a
    // yellow hint at deploy, but calls still go through and surface the
    // daemon's own error at call time.
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
      const command = ALARM_COMMANDS[action];
      if (!command) {
        done(new Error(`unknown action: ${action}`));
        return;
      }
      const args = buildArgs(command, config, msg);
      const timeoutMs = msg.timeout;

      node.status({ fill: "yellow", shape: "ring", text: action });
      try {
        const result = await hub.call(command, args, timeoutMs);
        msg.payload = result;
        node.status({ fill: "green", shape: "dot", text: action });
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "error" });
        const wrapped = new Error(err.message || String(err));
        if (err.details) wrapped.details = err.details;
        done(wrapped);
      }
    });

    node.on("close", (done) => {
      offStatus();
      releaseHub(server);
      done();
    });
  }

  RED.nodes.registerType("openccu-loom-alarm", OpenccuLoomAlarmNode);
};

module.exports.ARG_NAMES = ARG_NAMES;
module.exports.ALARM_COMMANDS = ALARM_COMMANDS;
