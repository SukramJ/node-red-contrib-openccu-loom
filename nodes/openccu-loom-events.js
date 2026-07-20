"use strict";

const { getHub, releaseHub } = require("../lib/ws-hub");

module.exports = function (RED) {
  function OpenccuLoomEventsNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    if (!server) {
      node.status({ fill: "red", shape: "ring", text: "no server" });
      return;
    }

    const topics = (config.topics || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const hub = getHub(server);
    hub.addRef();

    if (topics.length > 0) hub.registerTopics(node.id, topics);

    const offEvent = hub.onEvent((frame) => {
      if (frame.__control) {
        // Subscription ACKs feed the node status instead of the flow:
        // they confirm the round trip, they are not events.
        if (frame.op === "subscribed" || frame.op === "unsubscribed") {
          const count = Array.isArray(frame.topics) ? frame.topics.length : 0;
          node.status({ fill: "green", shape: "dot", text: `${frame.op} (${count})` });
          return;
        }
        const ctrl = { control: frame.op };
        if (frame.seq != null) ctrl.seq = frame.seq;
        if (frame.oldest_seq != null) ctrl.oldest_seq = frame.oldest_seq;
        node.send({ payload: ctrl, control: frame.op });
        return;
      }
      const msg = { payload: frame };
      if (frame.topic) msg.topic = frame.topic;
      if (frame.type) msg.eventType = frame.type;
      if (frame.kind) msg.kind = frame.kind;
      if (frame.seq != null) msg.seq = frame.seq;
      node.send(msg);
    });

    const offStatus = hub.onStatus((s) => {
      if (typeof s === "object" && s && s.error) {
        node.status({ fill: "red", shape: "ring", text: "auth/err" });
        node.error(s.error);
        return;
      }
      switch (s) {
        case "open":
          node.status({ fill: "green", shape: "dot", text: "connected" });
          break;
        case "connecting":
          node.status({ fill: "yellow", shape: "ring", text: "connecting..." });
          break;
        case "disconnected":
          node.status({ fill: "red", shape: "ring", text: "disconnected" });
          break;
        case "closed":
          node.status({ fill: "grey", shape: "ring", text: "closed" });
          break;
        default:
          node.status({ fill: "grey", shape: "ring", text: String(s) });
      }
    });

    node.on("input", (msg, send, done) => {
      const op = msg.op || "subscribe";
      const t = msg.topics || msg.payload;
      if (op === "reauth") {
        if (!msg.token) return done(new Error("msg.token missing for reauth"));
        hub.reauth(msg.token);
        return done();
      }
      if (!t) return done(new Error("msg.topics or msg.payload missing"));
      const list = Array.isArray(t) ? t : [t];
      if (op === "subscribe") {
        const merged = new Set([...(hub.subscriptions.get(node.id) || []), ...list]);
        hub.registerTopics(node.id, Array.from(merged));
      } else if (op === "unsubscribe") {
        const remaining = (hub.subscriptions.get(node.id) || []).filter((x) => !list.includes(x));
        if (remaining.length === 0) hub.unregisterOwner(node.id);
        else hub.registerTopics(node.id, remaining);
        hub.sendUnsubscribe(list);
      } else {
        return done(new Error(`unknown op: ${op}`));
      }
      done();
    });

    node.on("close", (done) => {
      offEvent();
      offStatus();
      hub.unregisterOwner(node.id);
      releaseHub(server);
      done();
    });
  }

  RED.nodes.registerType("openccu-loom-events", OpenccuLoomEventsNode);
};
