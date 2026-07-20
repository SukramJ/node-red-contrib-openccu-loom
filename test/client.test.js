"use strict";

const assert = require("assert");
const http = require("http");
const { OpenccuLoomClient } = require("../lib/client");

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function serverConfig(port, extra) {
  return Object.assign(
    {
      host: "127.0.0.1",
      port,
      tls: false,
      authMethod: "basic",
      timeout: 2000,
      credentials: { username: "u", password: "p" },
    },
    extra || {}
  );
}

describe("OpenccuLoomClient", function () {
  it("sends Basic auth header", function (done) {
    let observed;
    startServer((req, res) => {
      observed = req.headers["authorization"];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }).then(async (srv) => {
      const port = srv.address().port;
      try {
        const client = new OpenccuLoomClient(serverConfig(port));
        const r = await client.get("/info");
        assert.strictEqual(r.status, 200);
        assert.ok(observed && observed.startsWith("Basic "));
        const decoded = Buffer.from(observed.slice(6), "base64").toString();
        assert.strictEqual(decoded, "u:p");
        srv.close(done);
      } catch (e) {
        srv.close(() => done(e));
      }
    });
  });

  it("sends Bearer auth header", function (done) {
    let observed;
    startServer((req, res) => {
      observed = req.headers["authorization"];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    }).then(async (srv) => {
      const port = srv.address().port;
      try {
        const client = new OpenccuLoomClient(
          serverConfig(port, {
            authMethod: "bearer",
            credentials: { token: "abc" },
          })
        );
        await client.get("/info");
        assert.strictEqual(observed, "Bearer abc");
        srv.close(done);
      } catch (e) {
        srv.close(() => done(e));
      }
    });
  });

  it("logs in and reuses session cookies for subsequent requests", function (done) {
    const calls = [];
    startServer((req, res) => {
      calls.push({
        url: req.url,
        cookie: req.headers["cookie"],
        csrf: req.headers["x-csrf-token"],
      });
      if (req.url === "/api/v1/auth/login") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": [
              "openccu_loom_session=sess123; Path=/; HttpOnly",
              "openccu_loom_csrf=csrf456; Path=/",
            ],
          });
          res.end(JSON.stringify({ user: "u" }));
        });
      } else if (req.url === "/api/v1/devices") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      } else if (req.url === "/api/v1/programs/1/execute") {
        res.writeHead(202);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    }).then(async (srv) => {
      const port = srv.address().port;
      try {
        const client = new OpenccuLoomClient(
          serverConfig(port, { authMethod: "session" })
        );
        await client.get("/devices");
        await client.post("/programs/1/execute");
        assert.strictEqual(calls.length, 3);
        assert.strictEqual(calls[0].url, "/api/v1/auth/login");
        assert.strictEqual(calls[1].url, "/api/v1/devices");
        assert.ok(
          calls[1].cookie && calls[1].cookie.includes("openccu_loom_session=sess123")
        );
        assert.strictEqual(calls[1].csrf, undefined);
        assert.strictEqual(calls[2].url, "/api/v1/programs/1/execute");
        assert.strictEqual(calls[2].csrf, "csrf456");
        srv.close(done);
      } catch (e) {
        srv.close(() => done(e));
      }
    });
  });

  it("re-logs in after 401 with session auth", function (done) {
    let loginCount = 0;
    let firstCall = true;
    startServer((req, res) => {
      if (req.url === "/api/v1/auth/login") {
        loginCount += 1;
        const sid = `sess${loginCount}`;
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": [
            `openccu_loom_session=${sid}; Path=/`,
            `openccu_loom_csrf=csrf${loginCount}; Path=/`,
          ],
        });
        res.end("{}");
        return;
      }
      if (req.url === "/api/v1/devices") {
        if (firstCall) {
          firstCall = false;
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ title: "Unauthorized" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
        return;
      }
      res.writeHead(404);
      res.end();
    }).then(async (srv) => {
      const port = srv.address().port;
      try {
        const client = new OpenccuLoomClient(
          serverConfig(port, { authMethod: "session" })
        );
        const r = await client.get("/devices");
        assert.strictEqual(r.status, 200);
        assert.strictEqual(loginCount, 2, "should have re-logged in after 401");
        srv.close(done);
      } catch (e) {
        srv.close(() => done(e));
      }
    });
  });

  it("forwards Idempotency-Key header on writes", function (done) {
    let observed;
    startServer((req, res) => {
      observed = req.headers["idempotency-key"];
      res.writeHead(202);
      res.end();
    }).then(async (srv) => {
      const port = srv.address().port;
      try {
        const client = new OpenccuLoomClient(serverConfig(port));
        await client.put(
          "/devices/00:1/data-points/X/value",
          { value: 1 },
          { headers: { "Idempotency-Key": "abc-123" } }
        );
        assert.strictEqual(observed, "abc-123");
        srv.close(done);
      } catch (e) {
        srv.close(() => done(e));
      }
    });
  });

  it("defaults to the daemon port 8119", function () {
    const client = new OpenccuLoomClient({
      host: "127.0.0.1",
      tls: false,
      credentials: {},
    });
    assert.ok(client.baseURL.includes(":8119"));
  });
});
