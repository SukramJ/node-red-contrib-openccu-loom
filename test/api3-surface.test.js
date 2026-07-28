"use strict";

// Covers the REST surface this package gained with the daemon's API 3.x:
// the new actions on existing nodes and the four nodes added for the
// group / diagram / link / recording endpoints. Every case pins the exact
// request (method, URL incl. query string, body) the node must produce,
// which is what a spec refresh would break first.

const assert = require("assert");
const http = require("http");
const helper = require("node-red-node-test-helper");

const serverNode = require("../nodes/openccu-loom-server.js");
const programNode = require("../nodes/openccu-loom-program.js");
const deviceAdminNode = require("../nodes/openccu-loom-device-admin.js");
const messagesNode = require("../nodes/openccu-loom-messages.js");
const installModeNode = require("../nodes/openccu-loom-install-mode.js");
const sysvarNode = require("../nodes/openccu-loom-sysvar.js");
const paramsetNode = require("../nodes/openccu-loom-paramset.js");
const centralsNode = require("../nodes/openccu-loom-centrals.js");
const groupsNode = require("../nodes/openccu-loom-groups.js");
const diagramsNode = require("../nodes/openccu-loom-diagrams.js");
const linksNode = require("../nodes/openccu-loom-links.js");
const recordingNode = require("../nodes/openccu-loom-recording.js");
const alarmAdminNode = require("../nodes/openccu-loom-alarm-admin.js");

helper.init(require.resolve("node-red"));

// Echoes every request back as the response body, so a single backend
// serves every case below and the assertions can compare the request the
// node built rather than a hand-written fixture per endpoint.
function startEchoBackend() {
  return new Promise((resolve) => {
    const requests = [];
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let body = null;
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch (_) {
            body = raw;
          }
        }
        const entry = { method: req.method, url: req.url.replace(/^\/api\/v1/, ""), body };
        // The server config node handshakes with GET /info at deploy; that
        // is not part of any node's own request surface.
        if (entry.url !== "/info") requests.push(entry);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ echo: entry }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, requests }));
  });
}

// Loads a flow and waits for the server node's deploy-time handshake to
// settle. Without that wait the GET /info (and the alarm-admin capability
// probe riding on it) can still be queued in undici's connection pool when
// the test ends; the backend then closes under a live socket and undici
// raises an uncaught "setTypeOfService EINVAL" that mocha charges to
// whichever hook happens to be running.
function loadFlow(mod, type, nodeConfig, port) {
  return new Promise((resolve, reject) => {
    helper.load([serverNode, mod], flow(port, type, nodeConfig), () => {
      // One turn of the event loop, so the constructor's own setImmediate
      // has fired and refreshInfo(false) below joins that in-flight call
      // instead of starting a second one.
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
  // --- program -------------------------------------------------------
  [
    "program list forwards include_internal",
    programNode,
    "openccu-loom-program",
    { mode: "list" },
    { includeInternal: true },
    { method: "GET", url: "/programs?include_internal=true", body: null },
  ],
  [
    "program list without the flag leaves the daemon default in charge",
    programNode,
    "openccu-loom-program",
    { mode: "list" },
    {},
    { method: "GET", url: "/programs", body: null },
  ],
  [
    "program execute sends check_conditions only when asked",
    programNode,
    "openccu-loom-program",
    { mode: "execute", programId: "1234" },
    { checkConditions: true },
    { method: "POST", url: "/programs/1234/execute", body: { check_conditions: true } },
  ],
  [
    "program execute stays body-less by default",
    programNode,
    "openccu-loom-program",
    { mode: "execute", programId: "1234" },
    {},
    { method: "POST", url: "/programs/1234/execute", body: null },
  ],
  [
    "program delete targets one central",
    programNode,
    "openccu-loom-program",
    { mode: "delete", programId: "1234" },
    { central: "Home" },
    { method: "DELETE", url: "/programs/1234?central=Home", body: null },
  ],
  [
    "program set-active PATCHes the active flag",
    programNode,
    "openccu-loom-program",
    { mode: "set-active", programId: "1234" },
    { active: false },
    { method: "PATCH", url: "/programs/1234", body: { active: false } },
  ],

  // --- device-admin --------------------------------------------------
  [
    "device-admin accept carries first-time configuration",
    deviceAdminNode,
    "openccu-loom-device-admin",
    { action: "accept", address: "AABBCC" },
    { name: "Lampe", includeChannels: true, rooms: ["Wohnzimmer"], functions: ["Licht"] },
    {
      method: "POST",
      url: "/devices/AABBCC/accept",
      body: { name: "Lampe", include_channels: true, rooms: ["Wohnzimmer"], functions: ["Licht"] },
    },
  ],
  [
    "device-admin accept without configuration stays body-less",
    deviceAdminNode,
    "openccu-loom-device-admin",
    { action: "accept", address: "AABBCC" },
    {},
    { method: "POST", url: "/devices/AABBCC/accept", body: null },
  ],
  [
    "device-admin rename PATCHes the device",
    deviceAdminNode,
    "openccu-loom-device-admin",
    { action: "rename", address: "AABBCC" },
    { name: "Flur", includeChannels: true },
    { method: "PATCH", url: "/devices/AABBCC", body: { name: "Flur", include_channels: true } },
  ],
  [
    "device-admin delete forwards reset and force",
    deviceAdminNode,
    "openccu-loom-device-admin",
    { action: "delete", address: "AABBCC" },
    { reset: true, force: true },
    { method: "DELETE", url: "/devices/AABBCC?reset=true&force=true", body: null },
  ],
  [
    "device-admin delete without flags is a plain unpair",
    deviceAdminNode,
    "openccu-loom-device-admin",
    { action: "delete", address: "AABBCC" },
    {},
    { method: "DELETE", url: "/devices/AABBCC", body: null },
  ],
  [
    "device-admin test",
    deviceAdminNode,
    "openccu-loom-device-admin",
    { action: "test", address: "AABBCC" },
    {},
    { method: "POST", url: "/devices/AABBCC/test", body: null },
  ],
  [
    "device-admin restore-config",
    deviceAdminNode,
    "openccu-loom-device-admin",
    { action: "restore-config", address: "AABBCC" },
    {},
    { method: "POST", url: "/devices/AABBCC/config/restore", body: null },
  ],
  [
    "device-admin replace-candidates",
    deviceAdminNode,
    "openccu-loom-device-admin",
    { action: "replace-candidates", address: "AABBCC" },
    { central: "Home" },
    { method: "GET", url: "/devices/AABBCC/replace-candidates?central=Home", body: null },
  ],
  [
    "device-admin replace names the old device",
    deviceAdminNode,
    "openccu-loom-device-admin",
    { action: "replace", address: "NEW1" },
    { oldAddress: "OLD1", central: "Home" },
    { method: "POST", url: "/devices/NEW1/replace", body: { old_address: "OLD1", central: "Home" } },
  ],
  [
    "device-admin firmware-download",
    deviceAdminNode,
    "openccu-loom-device-admin",
    { action: "firmware-download" },
    { url: "https://example.invalid/fw.tgz" },
    { method: "POST", url: "/system/firmware/download", body: { url: "https://example.invalid/fw.tgz" } },
  ],
  [
    "device-admin channel-update",
    deviceAdminNode,
    "openccu-loom-device-admin",
    { action: "channel-update", address: "AABBCC", channel: "1" },
    { name: "Kanal 1", rooms: ["Bad"] },
    { method: "PATCH", url: "/devices/AABBCC/channels/1", body: { name: "Kanal 1", rooms: ["Bad"] } },
  ],
  [
    "device-admin channel-flags read",
    deviceAdminNode,
    "openccu-loom-device-admin",
    { action: "channel-flags", address: "AABBCC", channel: "1" },
    {},
    { method: "GET", url: "/devices/AABBCC/channels/1/flags", body: null },
  ],
  [
    "device-admin channel-flags-set coerces both flags to booleans",
    deviceAdminNode,
    "openccu-loom-device-admin",
    { action: "channel-flags-set", address: "AABBCC", channel: "1" },
    { hidden: 1, locked: 0 },
    { method: "PUT", url: "/devices/AABBCC/channels/1/flags", body: { hidden: true, locked: false } },
  ],
  [
    "device-admin team-candidates",
    deviceAdminNode,
    "openccu-loom-device-admin",
    { action: "team-candidates", address: "AABBCC", channel: "2" },
    {},
    { method: "GET", url: "/devices/AABBCC/channels/2/team-candidates", body: null },
  ],
  [
    "device-admin team-set with an empty team detaches the channel",
    deviceAdminNode,
    "openccu-loom-device-admin",
    { action: "team-set", address: "AABBCC", channel: "2" },
    { team: "" },
    { method: "PUT", url: "/devices/AABBCC/channels/2/team", body: { team: "" } },
  ],

  // --- messages ------------------------------------------------------
  [
    "messages ack-all on the alarm queue",
    messagesNode,
    "openccu-loom-messages",
    { kind: "alarm", action: "ack-all" },
    { central: "Home" },
    { method: "POST", url: "/alarm-messages/ack-all?central=Home", body: null },
  ],
  [
    "messages ack-all on the service queue",
    messagesNode,
    "openccu-loom-messages",
    { kind: "service", action: "ack-all" },
    {},
    { method: "POST", url: "/service-messages/ack-all", body: null },
  ],
  [
    "messages suppressed",
    messagesNode,
    "openccu-loom-messages",
    { kind: "service", action: "suppressed" },
    {},
    { method: "GET", url: "/service-messages/suppressed", body: null },
  ],
  [
    "messages unsuppress narrows by interface and parameter",
    messagesNode,
    "openccu-loom-messages",
    { kind: "service", action: "unsuppress" },
    { channel: "AABBCC:1", interface: "HmIP-RF", parameter: "LOW_BAT" },
    {
      method: "POST",
      url: "/service-messages/unsuppress",
      body: { channel: "AABBCC:1", interface: "HmIP-RF", parameter: "LOW_BAT" },
    },
  ],

  // --- install-mode / sysvar / paramset / centrals --------------------
  [
    "install-mode search scans one wired interface",
    installModeNode,
    "openccu-loom-install-mode",
    { action: "search" },
    { interface: "BidCos-Wired", central: "Home" },
    { method: "POST", url: "/install-mode/search", body: { interface: "BidCos-Wired", central: "Home" } },
  ],
  [
    "sysvar usage",
    sysvarNode,
    "openccu-loom-sysvar",
    { mode: "usage", sysvar: "Presence" },
    { central: "Home" },
    { method: "GET", url: "/sysvars/Presence/usage?central=Home", body: null },
  ],
  [
    "paramset determine is channel-scoped",
    paramsetNode,
    "openccu-loom-paramset",
    { mode: "determine", address: "AABBCC", key: "MASTER" },
    { channel: "1", parameter: "TEMPERATURE_OFFSET" },
    {
      method: "POST",
      url: "/devices/AABBCC/channels/1/paramsets/MASTER/determine",
      body: { parameter: "TEMPERATURE_OFFSET" },
    },
  ],
  [
    "centrals reboot",
    centralsNode,
    "openccu-loom-centrals",
    { action: "reboot", centralName: "Home" },
    {},
    { method: "POST", url: "/system/ccu/Home/reboot", body: null },
  ],

  // --- groups --------------------------------------------------------
  [
    "groups list",
    groupsNode,
    "openccu-loom-groups",
    { action: "list" },
    { central: "Home" },
    { method: "GET", url: "/groups?central=Home", body: null },
  ],
  [
    "groups types",
    groupsNode,
    "openccu-loom-groups",
    { action: "types" },
    {},
    { method: "GET", url: "/groups/types", body: null },
  ],
  [
    "groups suitable-members",
    groupsNode,
    "openccu-loom-groups",
    { action: "suitable-members" },
    { typeId: "HEATING", central: "Home" },
    { method: "GET", url: "/groups/suitable-members?central=Home&type_id=HEATING", body: null },
  ],
  [
    "groups create",
    groupsNode,
    "openccu-loom-groups",
    { action: "create" },
    { typeId: "HEATING", groupName: "Bad", members: [{ address: "AABBCC:1" }], forbidSingleOperation: true },
    {
      method: "POST",
      url: "/groups",
      body: {
        type_id: "HEATING",
        name: "Bad",
        forbid_single_operation: true,
        members: [{ address: "AABBCC:1" }],
      },
    },
  ],
  [
    "groups update",
    groupsNode,
    "openccu-loom-groups",
    { action: "update" },
    { groupId: 7, groupName: "Bad neu", members: [] },
    { method: "PUT", url: "/groups/7", body: { name: "Bad neu", members: [] } },
  ],
  [
    "groups delete",
    groupsNode,
    "openccu-loom-groups",
    { action: "delete" },
    { groupId: 7, central: "Home" },
    { method: "DELETE", url: "/groups/7?central=Home", body: null },
  ],

  // --- diagrams ------------------------------------------------------
  [
    "diagrams list",
    diagramsNode,
    "openccu-loom-diagrams",
    { action: "list" },
    {},
    { method: "GET", url: "/diagrams", body: null },
  ],
  [
    "diagrams get",
    diagramsNode,
    "openccu-loom-diagrams",
    { action: "get" },
    { diagramId: "d-1" },
    { method: "GET", url: "/diagrams/d-1", body: null },
  ],
  [
    "diagrams create carries name, visibility and config",
    diagramsNode,
    "openccu-loom-diagrams",
    { action: "create" },
    { diagramName: "Heizung", visibility: "shared", config: { series: [] } },
    { method: "POST", url: "/diagrams", body: { name: "Heizung", visibility: "shared", config: { series: [] } } },
  ],
  [
    "diagrams update",
    diagramsNode,
    "openccu-loom-diagrams",
    { action: "update" },
    { diagramId: "d-1", diagramName: "Heizung" },
    { method: "PUT", url: "/diagrams/d-1", body: { name: "Heizung" } },
  ],
  [
    "diagrams delete",
    diagramsNode,
    "openccu-loom-diagrams",
    { action: "delete" },
    { diagramId: "d-1" },
    { method: "DELETE", url: "/diagrams/d-1", body: null },
  ],

  // --- links ---------------------------------------------------------
  [
    "links list forwards central and locale",
    linksNode,
    "openccu-loom-links",
    { action: "list" },
    { central: "Home", locale: "de" },
    { method: "GET", url: "/links?central=Home&locale=de", body: null },
  ],
  [
    "links test activates the link paramset at the device",
    linksNode,
    "openccu-loom-links",
    { action: "test" },
    { address: "AABBCC", senderAddress: "AABBCC:1", receiverAddress: "DDEEFF:2", longPress: true },
    {
      method: "POST",
      url: "/devices/AABBCC/links/test",
      body: { sender_address: "AABBCC:1", receiver_address: "DDEEFF:2", long_press: true },
    },
  ],

  // --- recording -----------------------------------------------------
  [
    "recording get sends all four coordinates as query params",
    recordingNode,
    "openccu-loom-recording",
    { action: "get" },
    { central: "Home", interfaceId: "HmIP-RF", channel: "AABBCC:1", parameter: "ACTUAL_TEMPERATURE" },
    {
      method: "GET",
      url: "/history/recording?central=Home&interface_id=HmIP-RF&channel=AABBCC%3A1&parameter=ACTUAL_TEMPERATURE",
      body: null,
    },
  ],
  [
    "recording set omits `record` to clear the override",
    recordingNode,
    "openccu-loom-recording",
    { action: "set" },
    { central: "Home", interface_id: "HmIP-RF", channel: "AABBCC:1", parameter: "ACTUAL_TEMPERATURE" },
    {
      method: "PUT",
      url: "/history/recording",
      body: {
        central: "Home",
        interface_id: "HmIP-RF",
        channel: "AABBCC:1",
        parameter: "ACTUAL_TEMPERATURE",
      },
    },
  ],
  [
    "recording set forwards an explicit record flag",
    recordingNode,
    "openccu-loom-recording",
    { action: "set" },
    {
      central: "Home",
      interfaceId: "HmIP-RF",
      channel: "AABBCC:1",
      parameter: "ACTUAL_TEMPERATURE",
      record: true,
    },
    {
      method: "PUT",
      url: "/history/recording",
      body: {
        central: "Home",
        interface_id: "HmIP-RF",
        channel: "AABBCC:1",
        parameter: "ACTUAL_TEMPERATURE",
        record: true,
      },
    },
  ],

  // --- alarm admin (REST /alarm surface) ------------------------------
  [
    "alarm-admin state",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "state" },
    {},
    { method: "GET", url: "/alarm/state", body: null },
  ],
  [
    "alarm-admin journal forwards every filter",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "journal" },
    { zone: "zone-1", class: "trigger", limit: 50 },
    { method: "GET", url: "/alarm/journal?zone=zone-1&class=trigger&limit=50", body: null },
  ],
  [
    "alarm-admin zone-create",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "zone-create" },
    { payload: { id: "zone-1", name: "Erdgeschoss", position: 1 } },
    { method: "POST", url: "/alarm/zones", body: { id: "zone-1", name: "Erdgeschoss", position: 1 } },
  ],
  [
    "alarm-admin zone-update replaces the zone",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "zone-update", zoneId: "zone-1" },
    { payload: { id: "zone-1", name: "Erdgeschoss neu" } },
    { method: "PUT", url: "/alarm/zones/zone-1", body: { id: "zone-1", name: "Erdgeschoss neu" } },
  ],
  [
    "alarm-admin zone-delete",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "zone-delete", zoneId: "zone-1" },
    {},
    { method: "DELETE", url: "/alarm/zones/zone-1", body: null },
  ],
  [
    "alarm-admin sensors-set sends the full array",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "sensors-set", zoneId: "zone-1" },
    {
      payload: [
        {
          id: "s1",
          central: "Home",
          interface_id: "HmIP-RF",
          channel_address: "AABBCC:1",
          parameter: "STATE",
          type: "door",
        },
      ],
    },
    {
      method: "PUT",
      url: "/alarm/zones/zone-1/sensors",
      body: [
        {
          id: "s1",
          central: "Home",
          interface_id: "HmIP-RF",
          channel_address: "AABBCC:1",
          parameter: "STATE",
          type: "door",
        },
      ],
    },
  ],
  [
    "alarm-admin outputs-set with an empty array unenrols everything",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "outputs-set", zoneId: "zone-1" },
    { payload: [] },
    { method: "PUT", url: "/alarm/zones/zone-1/outputs", body: [] },
  ],
  [
    "alarm-admin output-candidates narrows by class",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "output-candidates" },
    { class: "acoustic_siren" },
    { method: "GET", url: "/alarm/output-candidates?class=acoustic_siren", body: null },
  ],
  [
    "alarm-admin remote-key-candidates",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "remote-key-candidates" },
    {},
    { method: "GET", url: "/alarm/remote-key-candidates", body: null },
  ],
  [
    "alarm-admin output-test honours optical_only",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "output-test" },
    { outputId: "o-1", opticalOnly: true },
    { method: "POST", url: "/alarm/outputs/o-1/test", body: { optical_only: true } },
  ],
  [
    "alarm-admin code-create",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "code-create" },
    { payload: { name: "Markus", kind: "pin", pin: "1234", perms: { arm: true }, enabled: true } },
    {
      method: "POST",
      url: "/alarm/codes",
      body: { name: "Markus", kind: "pin", pin: "1234", perms: { arm: true }, enabled: true },
    },
  ],
  [
    "alarm-admin code-delete",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "code-delete" },
    { codeId: "c-1" },
    { method: "DELETE", url: "/alarm/codes/c-1", body: null },
  ],
  [
    "alarm-admin walktest-start",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "walktest-start", zoneId: "zone-1" },
    {},
    { method: "POST", url: "/alarm/zones/zone-1/walktest/start", body: null },
  ],
  [
    "alarm-admin walktest-stop",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "walktest-stop", zoneId: "zone-1" },
    {},
    { method: "POST", url: "/alarm/zones/zone-1/walktest/stop", body: null },
  ],
  [
    "alarm-admin walktest status",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "walktest", zoneId: "zone-1" },
    {},
    { method: "GET", url: "/alarm/zones/zone-1/walktest", body: null },
  ],
  [
    "alarm-admin arm assembles the body from the msg fields",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "arm", zoneId: "zone-1" },
    { mode: "away", skipDelay: true, bypass: ["s1"], code: "1234" },
    {
      method: "POST",
      url: "/alarm/zones/zone-1/arm",
      body: { mode: "away", skip_delay: true, bypass: ["s1"], code: "1234" },
    },
  ],
  [
    "alarm-admin disarm sends the code when there is one",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "disarm", zoneId: "zone-1" },
    { code: "1234" },
    { method: "POST", url: "/alarm/zones/zone-1/disarm", body: { code: "1234" } },
  ],
  [
    "alarm-admin disarm without a code stays body-less",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "disarm", zoneId: "zone-1" },
    {},
    { method: "POST", url: "/alarm/zones/zone-1/disarm", body: null },
  ],
  [
    "alarm-admin silence-all",
    alarmAdminNode,
    "openccu-loom-alarm-admin",
    { action: "silence-all" },
    {},
    { method: "POST", url: "/alarm/silence-all", body: null },
  ],
];

describe("API 3.x REST surface", function () {
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
            assert.deepStrictEqual(requests, [expected]);
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

describe("API 3.x nodes: argument validation", function () {
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
      "groups suitable-members without a type id",
      groupsNode,
      "openccu-loom-groups",
      { action: "suitable-members" },
      {},
      /msg\.typeId missing/,
    ],
    [
      "groups update without a group id",
      groupsNode,
      "openccu-loom-groups",
      { action: "update" },
      { groupName: "x" },
      /msg\.groupId missing/,
    ],
    [
      "diagrams create without a name",
      diagramsNode,
      "openccu-loom-diagrams",
      { action: "create" },
      {},
      /needs msg\.diagramName/,
    ],
    [
      "links test without the two channel addresses",
      linksNode,
      "openccu-loom-links",
      { action: "test" },
      { address: "AABBCC" },
      /senderAddress and msg\.receiverAddress/,
    ],
    [
      "recording get with an incomplete coordinate set",
      recordingNode,
      "openccu-loom-recording",
      { action: "get" },
      { central: "Home", channel: "AABBCC:1" },
      /missing: msg\.interfaceId, msg\.parameter/,
    ],
    [
      "paramset determine without a channel",
      paramsetNode,
      "openccu-loom-paramset",
      { mode: "determine", address: "AABBCC" },
      { parameter: "TEMPERATURE_OFFSET" },
      /channel missing/,
    ],
    [
      "messages unsuppress without a channel",
      messagesNode,
      "openccu-loom-messages",
      { kind: "service", action: "unsuppress" },
      {},
      /msg\.channel missing/,
    ],
    [
      "device-admin replace without the old address",
      deviceAdminNode,
      "openccu-loom-device-admin",
      { action: "replace", address: "NEW1" },
      {},
      /msg\.oldAddress missing/,
    ],
    [
      "program set-active without a flag",
      programNode,
      "openccu-loom-program",
      { mode: "set-active", programId: "1234" },
      {},
      /msg\.active missing/,
    ],
    [
      "alarm-admin zone-create without id and name",
      alarmAdminNode,
      "openccu-loom-alarm-admin",
      { action: "zone-create" },
      { payload: { name: "no id" } },
      /needs an object msg\.payload with at least \{id, name\}/,
    ],
    [
      "alarm-admin sensors-set with a non-array payload",
      alarmAdminNode,
      "openccu-loom-alarm-admin",
      { action: "sensors-set", zoneId: "zone-1" },
      { payload: { id: "s1" } },
      /full array of sensor rows/,
    ],
    [
      "alarm-admin arm without a mode",
      alarmAdminNode,
      "openccu-loom-alarm-admin",
      { action: "arm", zoneId: "zone-1" },
      {},
      /msg\.mode missing/,
    ],
    [
      "alarm-admin readiness without a zone id",
      alarmAdminNode,
      "openccu-loom-alarm-admin",
      { action: "readiness" },
      {},
      /msg\.zoneId missing/,
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
