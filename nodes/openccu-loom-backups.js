"use strict";

const { createClient, describeError, FormData } = require("../lib/client");

module.exports = function (RED) {
  function OpenccuLoomBackupsNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    if (!server) {
      node.status({ fill: "red", shape: "ring", text: "no server" });
      return;
    }
    const client = createClient(server);

    node.on("input", async (msg, send, done) => {
      const action = msg.action || config.action || "list";
      const backupId = msg.backupId != null && msg.backupId !== "" ? msg.backupId : config.backupId;
      const needsBackup = () => {
        if (backupId != null && backupId !== "") return false;
        done(new Error("msg.backupId missing"));
        return true;
      };

      node.status({ fill: "yellow", shape: "ring", text: action });
      try {
        let res;
        switch (action) {
          case "list":
            res = await client.get("/backups");
            break;
          case "storage":
            res = await client.get("/backups/storage");
            break;

          case "trigger": {
            // Naming a central is optional; without it the daemon backs up
            // the first registered one.
            const central =
              msg.centralName != null && msg.centralName !== "" ? msg.centralName : config.centralName;
            res = await client.post("/backups", central ? { central_name: central } : {});
            break;
          }

          case "upload": {
            // msg.payload is the raw .sbk; the daemon wants it as the `file`
            // part of a multipart form, which the client detects by type.
            const bytes = msg.payload;
            if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
              return done(new Error("upload needs the .sbk archive as a Buffer in msg.payload"));
            }
            const filename =
              (msg.filename != null && msg.filename !== "" ? msg.filename : config.filename) || "backup.sbk";
            const form = new FormData();
            form.append("file", new Blob([bytes], { type: "application/octet-stream" }), String(filename));
            res = await client.post("/backups/upload", form);
            break;
          }

          case "download":
            if (needsBackup()) return;
            // Comes back as raw bytes, not JSON, so the flow can write it
            // straight to a file node.
            res = await client.get(`/backups/${encodeURIComponent(backupId)}/download`, {
              responseType: "buffer",
            });
            break;

          case "restore":
            // Dispatched asynchronously: the 202 says the restore was
            // accepted, not that the CCU has finished applying it.
            if (needsBackup()) return;
            res = await client.post(`/backups/${encodeURIComponent(backupId)}/restore`);
            break;

          case "delete":
            if (needsBackup()) return;
            res = await client.delete(`/backups/${encodeURIComponent(backupId)}`);
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

  RED.nodes.registerType("openccu-loom-backups", OpenccuLoomBackupsNode);
};
