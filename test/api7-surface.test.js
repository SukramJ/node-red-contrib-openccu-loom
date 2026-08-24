"use strict";

// Covers the REST surface this package gained with the daemon's API 7.x:
// the new actions on the alarm-admin / centrals / health nodes and the five
// nodes added for the security, Matter, area, backup and config-UI-surface
// endpoints. Same contract as api3-surface.test.js — every case pins the
// exact request (method, URL incl. query string, body) the node must
// produce, which is what a spec refresh would break first.

const assert = require("assert");
const http = require("http");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const alarmAdminNode = require("../nodes/openccu-loom-alarm-admin.js");
const centralsNode = require("../nodes/openccu-loom-centrals.js");
const healthNode = require("../nodes/openccu-loom-health.js");
const securityNode = require("../nodes/openccu-loom-security.js");
const matterNode = require("../nodes/openccu-loom-matter.js");
const areasNode = require("../nodes/openccu-loom-areas.js");
const backupsNode = require("../nodes/openccu-loom-backups.js");
const surfacesNode = require("../nodes/openccu-loom-surfaces.js");

helper.init(require.resolve("node-red"));

// Echoes every request back as the response body, so a single backend
// serves every case below. `bodyOverride` lets one test swap in a raw
// response (the binary download case) without a second server.
function startEchoBackend(respond) {
  return new Promise((resolve) => {
    const requests = [];
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const rawBuf = Buffer.concat(chunks);
        const raw = rawBuf.toString();
        let body = null;
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch (_) {
            body = raw;
          }
        }
        const entry = {
          method: req.method,
          url: req.url.replace(/^\/api\/v1/, ""),
          body,
        };
        // The server config node handshakes with GET /info at deploy; that
        // is not part of any node's own request surface.
        if (entry.url !== "/info") {
          requests.push(entry);
          // Kept off the compared entry so the table cases stay readable;
          // the multipart test reaches for them explicitly.
          entry.rawBody = rawBuf;
          entry.contentType = req.headers["content-type"] || "";
        }
        if (respond && respond(entry, res)) return;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ echo: { method: entry.method, url: entry.url, body: entry.body } }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, requests }));
  });
}

// Compares only the three fields every case cares about; the echo backend
// also records the raw body and content type for the multipart test.
function seen(requests) {
  return requests.map((r) => ({ method: r.method, url: r.url, body: r.body }));
}

function loadFlow(mod, type, nodeConfig, port) {
  return new Promise((resolve, reject) => {
    helper.load([serverNode, mod], flow(port, type, nodeConfig), () => {
      setImmediate(() => {
        helper.getNode("s1").refreshInfo(false).then(resolve, reject);
      });
    });
  });
}

function stopBackend(srv, done) {
  helper.unload().then(() => helper.stopServer(() => srv.close(() => done())));
}

function flow(port, type, extra) {
  return [
    {
      id: "s1",
      type: "openccu-loom-server",
      name: "test",
      host: "127.0.0.1",
      port,
      tls: false,
      authMethod: "basic",
      timeout: 1000,
    },
    Object.assign({ id: "n1", type, server: "s1", wires: [["n2"]] }, extra || {}),
    { id: "n2", type: "helper" },
  ];
}

// [title, node module, node type, node config, inbound msg, expected request]
const CASES = [
  // --- alarm-admin: incidents -----------------------------------------
  [
    "alarm-admin incidents scopes the history to one zone",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "incidents" },
    { zoneId: "zone-1" },
    { method: "GET", url: "/alarm/incidents?zone_id=zone-1", body: null },
  ],
  [
    "alarm-admin incidents forwards the row limit",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "incidents", zoneId: "zone-1" },
    { limit: 200 },
    { method: "GET", url: "/alarm/incidents?zone_id=zone-1&limit=200", body: null },
  ],
  [
    "alarm-admin incident reads one incident by id",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "incident" },
    { incidentId: 42 },
    { method: "GET", url: "/alarm/incidents/42", body: null },
  ],

  // --- alarm-admin: sensor candidates ---------------------------------
  [
    "alarm-admin sensor-candidates lists every candidate by default",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "sensor-candidates" },
    {},
    { method: "GET", url: "/alarm/sensor-candidates", body: null },
  ],
  [
    "alarm-admin sensor-candidates sends enrolled=false when narrowed",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "sensor-candidates" },
    { unenrolled: true },
    { method: "GET", url: "/alarm/sensor-candidates?enrolled=false", body: null },
  ],

  // --- alarm-admin: latched motion detectors --------------------------
  [
    "alarm-admin triggered-motion is fleet-wide without a zone",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "triggered-motion" },
    {},
    { method: "GET", url: "/alarm/triggered-motion", body: null },
  ],
  [
    "alarm-admin triggered-motion narrows to one zone",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "triggered-motion" },
    { zoneId: "zone-1" },
    { method: "GET", url: "/alarm/triggered-motion?zone_id=zone-1", body: null },
  ],
  [
    "alarm-admin reset-motion clears every zone",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "reset-motion" },
    {},
    { method: "POST", url: "/alarm/reset-motion", body: null },
  ],
  [
    "alarm-admin zone-reset-motion clears one zone",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "zone-reset-motion" },
    { zoneId: "zone-1" },
    { method: "POST", url: "/alarm/zones/zone-1/reset-motion", body: null },
  ],

  // --- centrals: CCU host control -------------------------------------
  [
    "centrals poweroff shuts the CCU host down",
    centralsNode,
    "openccu-loom-centrals",
    { action: "poweroff" },
    { centralName: "Home" },
    { method: "POST", url: "/system/ccu/Home/poweroff", body: null },
  ],
  [
    "centrals safe-mode restarts the CCU into safe mode",
    centralsNode,
    "openccu-loom-centrals",
    { action: "safe-mode", centralName: "Home" },
    {},
    { method: "POST", url: "/system/ccu/Home/safe-mode", body: null },
  ],
  [
    "centrals recovery-mode restarts the CCU into recovery",
    centralsNode,
    "openccu-loom-centrals",
    { action: "recovery-mode", centralName: "Home" },
    {},
    { method: "POST", url: "/system/ccu/Home/recovery-mode", body: null },
  ],

  // --- centrals: astro position ---------------------------------------
  [
    "centrals position takes the coordinates from msg fields",
    centralsNode,
    "openccu-loom-centrals",
    { action: "position", centralName: "Home" },
    { longitude: 8.6821, latitude: 50.1109 },
    { method: "PUT", url: "/system/ccu/Home/position", body: { longitude: 8.6821, latitude: 50.1109 } },
  ],
  [
    "centrals position takes them from a payload object too",
    centralsNode,
    "openccu-loom-centrals",
    { action: "position", centralName: "Home" },
    { payload: { longitude: -1.5, latitude: 0 } },
    { method: "PUT", url: "/system/ccu/Home/position", body: { longitude: -1.5, latitude: 0 } },
  ],
  [
    "centrals position falls back to the configured coordinates",
    centralsNode,
    "openccu-loom-centrals",
    { action: "position", centralName: "Home", longitude: "13.4", latitude: "52.5" },
    {},
    { method: "PUT", url: "/system/ccu/Home/position", body: { longitude: 13.4, latitude: 52.5 } },
  ],

  // --- centrals: add-on self-update -----------------------------------
  [
    "centrals addon-update reads the self-update status",
    centralsNode,
    "openccu-loom-centrals",
    { action: "addon-update" },
    {},
    { method: "GET", url: "/system/addon-update", body: null },
  ],
  [
    "centrals addon-update-check re-checks for a release",
    centralsNode,
    "openccu-loom-centrals",
    { action: "addon-update-check" },
    {},
    { method: "POST", url: "/system/addon-update/check", body: null },
  ],
  [
    "centrals addon-update-install starts the install",
    centralsNode,
    "openccu-loom-centrals",
    { action: "addon-update-install" },
    {},
    { method: "POST", url: "/system/addon-update/install", body: null },
  ],

  // --- health: the new read-only scopes -------------------------------
  [
    "health wiring reads the declared seams",
    healthNode,
    "openccu-loom-health",
    { scope: "wiring" },
    {},
    { method: "GET", url: "/diagnostics/wiring", body: null },
  ],
  [
    "health schedules reads the fleet-wide week-schedule overview",
    healthNode,
    "openccu-loom-health",
    { scope: "schedules" },
    {},
    { method: "GET", url: "/schedules", body: null },
  ],
  [
    "health i18n reads the vocabulary without a locale by default",
    healthNode,
    "openccu-loom-health",
    { scope: "i18n" },
    {},
    { method: "GET", url: "/i18n/entities", body: null },
  ],
  [
    "health i18n forwards the requested locale",
    healthNode,
    "openccu-loom-health",
    { scope: "i18n" },
    { locale: "de" },
    { method: "GET", url: "/i18n/entities?locale=de", body: null },
  ],
  [
    "health locale is scoped to i18n and never leaks into another read",
    healthNode,
    "openccu-loom-health",
    { scope: "health", locale: "de" },
    {},
    { method: "GET", url: "/health", body: null },
  ],

  // --- security --------------------------------------------------------
  [
    "security state reads the whole domain",
    securityNode,
    "openccu-loom-security",
    { action: "state" },
    {},
    { method: "GET", url: "/security", body: null },
  ],
  [
    "security class reads one hazard class",
    securityNode,
    "openccu-loom-security",
    { action: "class" },
    { class: "smoke" },
    { method: "GET", url: "/security/classes/smoke", body: null },
  ],
  [
    "security faults reads the standing ledger",
    securityNode,
    "openccu-loom-security",
    { action: "faults" },
    {},
    { method: "GET", url: "/security/faults", body: null },
  ],
  [
    "security fault-acknowledge marks one fault as seen",
    securityNode,
    "openccu-loom-security",
    { action: "fault-acknowledge" },
    { faultId: "f-7" },
    { method: "POST", url: "/security/faults/f-7/acknowledge", body: null },
  ],
  [
    "security sources is unfiltered by default",
    securityNode,
    "openccu-loom-security",
    { action: "sources" },
    {},
    { method: "GET", url: "/security/sources", body: null },
  ],
  [
    "security sources forwards every filter and flag",
    securityNode,
    "openccu-loom-security",
    { action: "sources" },
    { class: "water", central: "Home", zone_id: "zone-1", relevant: true, active: true },
    {
      method: "GET",
      url: "/security/sources?class=water&central=Home&zone_id=zone-1&relevant=true&active=true",
      body: null,
    },
  ],
  [
    "security sources leaves a false flag off entirely",
    securityNode,
    "openccu-loom-security",
    { action: "sources" },
    { central: "Home", relevant: false },
    { method: "GET", url: "/security/sources?central=Home", body: null },
  ],
  [
    "security source-override URL-encodes the routing key",
    securityNode,
    "openccu-loom-security",
    { action: "source-override" },
    { ref: "Home|BidCos-RF|ABC0123456:1|STATE", payload: { class: "tamper", note: "Wandkontakt" } },
    {
      method: "PUT",
      url: "/security/sources/Home%7CBidCos-RF%7CABC0123456%3A1%7CSTATE",
      body: { class: "tamper", note: "Wandkontakt" },
    },
  ],
  [
    "security source-override can exclude a source",
    securityNode,
    "openccu-loom-security",
    { action: "source-override", ref: "Home|BidCos-RF|ABC0123456:1|STATE" },
    { payload: { included: false } },
    {
      method: "PUT",
      url: "/security/sources/Home%7CBidCos-RF%7CABC0123456%3A1%7CSTATE",
      body: { included: false },
    },
  ],

  // --- matter: reads ---------------------------------------------------
  [
    "matter status reads the bridge runtime state",
    matterNode,
    "openccu-loom-matter",
    { action: "status" },
    {},
    { method: "GET", url: "/matter/status", body: null },
  ],
  [
    "matter compatibility reads the per-ecosystem verdict",
    matterNode,
    "openccu-loom-matter",
    { action: "compatibility" },
    {},
    { method: "GET", url: "/matter/compatibility", body: null },
  ],
  [
    "matter endpoints reads the assembled topology",
    matterNode,
    "openccu-loom-matter",
    { action: "endpoints" },
    {},
    { method: "GET", url: "/matter/endpoints", body: null },
  ],
  [
    "matter mdns reads what the bridge advertises",
    matterNode,
    "openccu-loom-matter",
    { action: "mdns" },
    {},
    { method: "GET", url: "/matter/mdns", body: null },
  ],
  [
    "matter sessions reads the open sessions",
    matterNode,
    "openccu-loom-matter",
    { action: "sessions" },
    {},
    { method: "GET", url: "/matter/sessions", body: null },
  ],
  [
    "matter events reads the pairing/session ledger",
    matterNode,
    "openccu-loom-matter",
    { action: "events" },
    {},
    { method: "GET", url: "/matter/events", body: null },
  ],
  [
    "matter setup-payload reads the pairing code",
    matterNode,
    "openccu-loom-matter",
    { action: "setup-payload" },
    {},
    { method: "GET", url: "/matter/setup-payload", body: null },
  ],

  // --- matter: topology and fabrics ------------------------------------
  [
    "matter force-sync re-assembles the topology",
    matterNode,
    "openccu-loom-matter",
    { action: "force-sync" },
    {},
    { method: "POST", url: "/matter/force-sync", body: null },
  ],
  [
    "matter fabric-delete unpairs one fabric",
    matterNode,
    "openccu-loom-matter",
    { action: "fabric-delete" },
    { fabricId: "3" },
    { method: "DELETE", url: "/matter/fabrics/3", body: null },
  ],
  [
    "matter factory-reset supplies the confirmation token itself",
    matterNode,
    "openccu-loom-matter",
    { action: "factory-reset" },
    {},
    { method: "POST", url: "/matter/factory-reset", body: { confirm: "remove-all-fabrics" } },
  ],

  // --- matter: allowlist -----------------------------------------------
  [
    "matter exposable-set updates one allowlist row",
    matterNode,
    "openccu-loom-matter",
    { action: "exposable-set" },
    {
      payload: {
        central_name: "Home",
        device_address: "ABC0123456",
        channel_no: 1,
        dp_kind: "generic",
        dp_key: "STATE",
        enabled: true,
      },
    },
    {
      method: "PUT",
      url: "/matter/exposable",
      body: {
        central_name: "Home",
        device_address: "ABC0123456",
        channel_no: 1,
        dp_kind: "generic",
        dp_key: "STATE",
        enabled: true,
      },
    },
  ],
  [
    "matter exposable-bulk wraps a bare array in items",
    matterNode,
    "openccu-loom-matter",
    { action: "exposable-bulk" },
    { payload: [{ dp_key: "STATE", enabled: true }] },
    { method: "POST", url: "/matter/exposable/bulk", body: { items: [{ dp_key: "STATE", enabled: true }] } },
  ],
  [
    "matter exposable-bulk passes an already-wrapped payload through",
    matterNode,
    "openccu-loom-matter",
    { action: "exposable-bulk" },
    { payload: { items: [{ dp_key: "LEVEL", enabled: false }] } },
    { method: "POST", url: "/matter/exposable/bulk", body: { items: [{ dp_key: "LEVEL", enabled: false }] } },
  ],

  // --- matter: commissioning -------------------------------------------
  [
    "matter commissioning-window reads the window state",
    matterNode,
    "openccu-loom-matter",
    { action: "commissioning-window" },
    {},
    { method: "GET", url: "/matter/commissioning/window", body: null },
  ],
  [
    "matter commissioning-open leaves the duration to the daemon",
    matterNode,
    "openccu-loom-matter",
    { action: "commissioning-open" },
    {},
    { method: "POST", url: "/matter/commissioning/window", body: null },
  ],
  [
    "matter commissioning-open forwards a duration",
    matterNode,
    "openccu-loom-matter",
    { action: "commissioning-open" },
    { durationSeconds: 300 },
    { method: "POST", url: "/matter/commissioning/window", body: { duration_seconds: 300 } },
  ],
  [
    "matter commissioning-close closes the window early",
    matterNode,
    "openccu-loom-matter",
    { action: "commissioning-close" },
    {},
    { method: "POST", url: "/matter/commissioning/window/close", body: null },
  ],
  [
    "matter share opens a window for a second ecosystem",
    matterNode,
    "openccu-loom-matter",
    { action: "share", durationSeconds: 600 },
    {},
    { method: "POST", url: "/matter/share", body: { duration_seconds: 600 } },
  ],

  // --- areas ------------------------------------------------------------
  [
    "areas list reads every area with its rooms",
    areasNode,
    "openccu-loom-areas",
    { action: "list" },
    {},
    { method: "GET", url: "/areas", body: null },
  ],
  [
    "areas create sends the area object without minting an id",
    areasNode,
    "openccu-loom-areas",
    { action: "create" },
    { payload: { name: "Obergeschoss", position: 2 } },
    { method: "POST", url: "/areas", body: { name: "Obergeschoss", position: 2 } },
  ],
  [
    "areas update replaces the area",
    areasNode,
    "openccu-loom-areas",
    { action: "update" },
    { areaId: "a-1", payload: { id: "a-1", name: "Dachgeschoss" } },
    { method: "PUT", url: "/areas/a-1", body: { id: "a-1", name: "Dachgeschoss" } },
  ],
  [
    "areas delete removes the area",
    areasNode,
    "openccu-loom-areas",
    { action: "delete", areaId: "a-1" },
    {},
    { method: "DELETE", url: "/areas/a-1", body: null },
  ],
  [
    "areas rooms-set replaces the full room set",
    areasNode,
    "openccu-loom-areas",
    { action: "rooms-set", areaId: "a-1" },
    { payload: [{ central: "Home", room: "Küche" }] },
    { method: "PUT", url: "/areas/a-1/rooms", body: [{ central: "Home", room: "Küche" }] },
  ],
  [
    "areas rooms-set clears the area with an empty array",
    areasNode,
    "openccu-loom-areas",
    { action: "rooms-set", areaId: "a-1" },
    { payload: [] },
    { method: "PUT", url: "/areas/a-1/rooms", body: [] },
  ],

  // --- backups -----------------------------------------------------------
  [
    "backups list reads the stored archives",
    backupsNode,
    "openccu-loom-backups",
    { action: "list" },
    {},
    { method: "GET", url: "/backups", body: null },
  ],
  [
    "backups storage reads where they are kept",
    backupsNode,
    "openccu-loom-backups",
    { action: "storage" },
    {},
    { method: "GET", url: "/backups/storage", body: null },
  ],
  [
    "backups trigger without a central leaves the choice to the daemon",
    backupsNode,
    "openccu-loom-backups",
    { action: "trigger" },
    {},
    { method: "POST", url: "/backups", body: {} },
  ],
  [
    "backups trigger names the central when given one",
    backupsNode,
    "openccu-loom-backups",
    { action: "trigger" },
    { centralName: "Home" },
    { method: "POST", url: "/backups", body: { central_name: "Home" } },
  ],
  [
    "backups restore dispatches the restore",
    backupsNode,
    "openccu-loom-backups",
    { action: "restore" },
    { backupId: "b-1" },
    { method: "POST", url: "/backups/b-1/restore", body: null },
  ],
  [
    "backups delete removes one stored archive",
    backupsNode,
    "openccu-loom-backups",
    { action: "delete", backupId: "b-1" },
    {},
    { method: "DELETE", url: "/backups/b-1", body: null },
  ],

  // --- config-UI surfaces -------------------------------------------------
  [
    "surfaces get reads the registry and the live profile",
    surfacesNode,
    "openccu-loom-surfaces",
    { action: "get" },
    {},
    { method: "GET", url: "/ui/surfaces", body: null },
  ],
  [
    "surfaces set flips the embedded master toggle",
    surfacesNode,
    "openccu-loom-surfaces",
    { action: "set" },
    { payload: { embedded: true, embedded_scope: "inside_ha" } },
    { method: "PUT", url: "/ui/surfaces", body: { embedded: true, embedded_scope: "inside_ha" } },
  ],
  [
    "surfaces set sends the full profile override set",
    surfacesNode,
    "openccu-loom-surfaces",
    { action: "set" },
    { payload: { profiles: { operator: { devices: "visible", matter: "hidden" } } } },
    { method: "PUT", url: "/ui/surfaces", body: { profiles: { operator: { devices: "visible", matter: "hidden" } } } },
  ],
];

describe("API 7.x REST surface", function () {
  let backend;
  let requests;

  beforeEach(function (done) {
    startEchoBackend().then(({ srv, requests: r }) => {
      backend = srv;
      requests = r;
      helper.startServer(done);
    });
  });

  afterEach(function (done) {
    stopBackend(backend, done);
  });

  for (const [title, mod, type, nodeConfig, inbound, expected] of CASES) {
    it(title, function (done) {
      loadFlow(mod, type, nodeConfig, backend.address().port).then(() => {
        const n2 = helper.getNode("n2");
        n2.on("input", () => {
          try {
            assert.deepStrictEqual(seen(requests), [expected]);
            done();
          } catch (e) {
            done(e);
          }
        });
        helper.getNode("n1").receive({ ...inbound });
      }, done);
    });
  }
});

describe("API 7.x nodes: argument validation", function () {
  let backend;
  let requests;

  beforeEach(function (done) {
    startEchoBackend().then(({ srv, requests: r }) => {
      backend = srv;
      requests = r;
      helper.startServer(done);
    });
  });

  afterEach(function (done) {
    stopBackend(backend, done);
  });

  // [title, node module, node type, node config, inbound msg, expected error pattern]
  const INVALID = [
    [
      "alarm-admin incidents without a zone id",
      alarmAdminNode,
      "openccu-loom-alarm-admin",
      { action: "incidents" },
      {},
      /msg\.zoneId missing/,
    ],
    [
      "alarm-admin incident without an incident id",
      alarmAdminNode,
      "openccu-loom-alarm-admin",
      { action: "incident" },
      {},
      /msg\.incidentId missing/,
    ],
    [
      "alarm-admin zone-reset-motion without a zone id",
      alarmAdminNode,
      "openccu-loom-alarm-admin",
      { action: "zone-reset-motion" },
      {},
      /msg\.zoneId missing/,
    ],
    [
      "centrals poweroff without a central",
      centralsNode,
      "openccu-loom-centrals",
      { action: "poweroff" },
      {},
      /centralName missing/,
    ],
    [
      "centrals position with only one coordinate",
      centralsNode,
      "openccu-loom-centrals",
      { action: "position", centralName: "Home" },
      { longitude: 8.68 },
      /needs longitude and latitude/,
    ],
    [
      "security class without a class",
      securityNode,
      "openccu-loom-security",
      { action: "class" },
      {},
      /msg\.class missing/,
    ],
    [
      "security class with an unknown class",
      securityNode,
      "openccu-loom-security",
      { action: "class" },
      { class: "fire" },
      /unknown class: fire/,
    ],
    [
      "security sources with an unknown class filter",
      securityNode,
      "openccu-loom-security",
      { action: "sources" },
      { class: "flood" },
      /unknown class: flood/,
    ],
    [
      "security fault-acknowledge without a fault id",
      securityNode,
      "openccu-loom-security",
      { action: "fault-acknowledge" },
      {},
      /msg\.faultId missing/,
    ],
    [
      "security source-override without a routing key",
      securityNode,
      "openccu-loom-security",
      { action: "source-override" },
      { payload: { class: "smoke" } },
      /msg\.ref missing/,
    ],
    [
      "security source-override without a payload",
      securityNode,
      "openccu-loom-security",
      { action: "source-override", ref: "Home|BidCos-RF|ABC:1|STATE" },
      {},
      /needs an object msg\.payload/,
    ],
    [
      "security source-override with an unknown class",
      securityNode,
      "openccu-loom-security",
      { action: "source-override", ref: "Home|BidCos-RF|ABC:1|STATE" },
      { payload: { class: "fire" } },
      /unknown class: fire/,
    ],
    [
      "matter fabric-delete without a fabric id",
      matterNode,
      "openccu-loom-matter",
      { action: "fabric-delete" },
      {},
      /msg\.fabricId missing/,
    ],
    [
      "matter exposable-set without a payload",
      matterNode,
      "openccu-loom-matter",
      { action: "exposable-set" },
      {},
      /needs an object msg\.payload/,
    ],
    [
      "matter exposable-bulk with neither an array nor items",
      matterNode,
      "openccu-loom-matter",
      { action: "exposable-bulk" },
      { payload: { dp_key: "STATE" } },
      /needs an array msg\.payload/,
    ],
    [
      "areas create without a name",
      areasNode,
      "openccu-loom-areas",
      { action: "create" },
      { payload: { position: 1 } },
      /at least \{name\}/,
    ],
    [
      "areas update without an area id",
      areasNode,
      "openccu-loom-areas",
      { action: "update" },
      { payload: { id: "a-1", name: "x" } },
      /msg\.areaId missing/,
    ],
    [
      "areas rooms-set with a non-array payload",
      areasNode,
      "openccu-loom-areas",
      { action: "rooms-set", areaId: "a-1" },
      { payload: { central: "Home", room: "Küche" } },
      /needs an array msg\.payload/,
    ],
    [
      "backups download without a backup id",
      backupsNode,
      "openccu-loom-backups",
      { action: "download" },
      {},
      /msg\.backupId missing/,
    ],
    [
      "backups upload without the archive bytes",
      backupsNode,
      "openccu-loom-backups",
      { action: "upload" },
      { payload: { not: "a buffer" } },
      /as a Buffer in msg\.payload/,
    ],
    [
      "surfaces set without a payload",
      surfacesNode,
      "openccu-loom-surfaces",
      { action: "set" },
      {},
      /needs an object msg\.payload/,
    ],
    [
      "surfaces set with an unknown embedded scope",
      surfacesNode,
      "openccu-loom-surfaces",
      { action: "set" },
      { payload: { embedded_scope: "everywhere" } },
      /unknown embedded_scope: everywhere/,
    ],
  ];

  for (const [title, mod, type, nodeConfig, inbound, pattern] of INVALID) {
    it(`errors without calling the backend: ${title}`, function (done) {
      loadFlow(mod, type, nodeConfig, backend.address().port).then(() => {
        const n1 = helper.getNode("n1");
        const n2 = helper.getNode("n2");
        let emitted = false;
        n2.on("input", () => {
          emitted = true;
        });
        const origError = n1.error.bind(n1);
        n1.error = function (err, msg) {
          try {
            const text = err && err.message ? err.message : String(err);
            assert.ok(pattern.test(text), `unexpected error: ${text}`);
            assert.strictEqual(emitted, false, "must not emit a message");
            assert.strictEqual(requests.length, 0, "must not call the backend");
            done();
          } catch (e) {
            done(e);
          }
          return origError(err, msg);
        };
        n1.receive({ ...inbound });
      }, done);
    });
  }
});

// The two backup verbs that do not speak JSON: the upload builds a
// multipart form, and the download must come back as untouched bytes.
describe("openccu-loom-backups: binary transfers", function () {
  let backend;
  let requests;

  afterEach(function (done) {
    stopBackend(backend, done);
  });

  it("uploads the .sbk as a multipart form part named file", function (done) {
    startEchoBackend().then(({ srv, requests: r }) => {
      backend = srv;
      requests = r;
      helper.startServer(() => {
        loadFlow(backupsNode, "openccu-loom-backups", { action: "upload" }, backend.address().port).then(() => {
          const n2 = helper.getNode("n2");
          n2.on("input", () => {
            try {
              assert.strictEqual(requests.length, 1);
              const req = requests[0];
              assert.strictEqual(req.method, "POST");
              assert.strictEqual(req.url, "/backups/upload");
              assert.ok(
                /^multipart\/form-data; boundary=/.test(req.contentType),
                `expected a multipart body, got "${req.contentType}"`
              );
              const raw = req.rawBody.toString("latin1");
              assert.ok(raw.includes('name="file"'), "the part must be named file");
              assert.ok(raw.includes('filename="ccu.sbk"'), "msg.filename must name the part");
              assert.ok(raw.includes("SBK-BYTES"), "the archive bytes must survive the transfer");
              done();
            } catch (e) {
              done(e);
            }
          });
          helper
            .getNode("n1")
            .receive({ payload: Buffer.from("SBK-BYTES"), filename: "ccu.sbk" });
        }, done);
      });
    });
  });

  it("returns the download as a Buffer rather than decoded text", function (done) {
    // 0x80 is not valid UTF-8 on its own: read as text it becomes U+FFFD,
    // which is exactly the corruption the buffer path exists to avoid.
    const sbk = Buffer.from([0x53, 0x42, 0x4b, 0x80, 0x00, 0xff]);
    startEchoBackend((entry, res) => {
      if (entry.url !== "/backups/b-1/download") return false;
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(sbk);
      return true;
    }).then(({ srv, requests: r }) => {
      backend = srv;
      requests = r;
      helper.startServer(() => {
        loadFlow(backupsNode, "openccu-loom-backups", { action: "download" }, backend.address().port).then(() => {
          const n2 = helper.getNode("n2");
          n2.on("input", (msg) => {
            try {
              assert.deepStrictEqual(seen(requests), [
                { method: "GET", url: "/backups/b-1/download", body: null },
              ]);
              assert.ok(Buffer.isBuffer(msg.payload), "the archive must arrive as a Buffer");
              assert.deepStrictEqual(msg.payload, sbk);
              assert.strictEqual(msg.statusCode, 200);
              done();
            } catch (e) {
              done(e);
            }
          });
          helper.getNode("n1").receive({ backupId: "b-1" });
        }, done);
      });
    });
  });
});
