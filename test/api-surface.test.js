"use strict";

// API-PIN contract test: pins the slice of the openccu-loom REST + WS
// surface this package actually uses against the vendored spec snapshots
// in spec/ (see spec/README.md for how those snapshots are refreshed).
// Catches two kinds of drift:
//  - a node/lib file calling a REST path, or an alarm action naming a WS
//    command, that no longer exists once the daemon's spec is refreshed;
//  - lib/client.js SUPPORTED_API_MAJOR silently drifting from the
//    vendored spec's major version.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SPEC_DIR = path.join(ROOT, "spec");
const OPENAPI_PATH = path.join(SPEC_DIR, "openapi.yaml");
const WSAPI_PATH = path.join(SPEC_DIR, "wsapi.json");

const openapiText = fs.readFileSync(OPENAPI_PATH, "utf8");
const wsapiText = fs.readFileSync(WSAPI_PATH, "utf8");
const wsapi = JSON.parse(wsapiText);

// --- openapi.yaml: minimal line-based extractor -----------------------
//
// Paths are the two-space-indented keys directly under the top-level
// "paths:" block, e.g. "  /devices/{addr}:". A path segment itself may
// contain a literal ":" (e.g. "/devices/values:batch"), so the pattern
// below captures everything up to the LAST colon on the line, not the
// first.
function loadOpenApiPaths(text) {
  const found = [];
  let inPaths = false;
  for (const line of text.split("\n")) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^\S/.test(line)) break; // the next top-level key ends the paths block
    const m = /^ {2}(\/.*):\s*$/.exec(line);
    if (m) found.push(m[1]);
  }
  return found;
}

// info.version lives as "  version: X.Y.Z", the first such 2-space
// indented "version:" line in the document (directly under "info:").
function loadOpenApiVersionMajor(text) {
  const m = /^ {2}version:\s*(\S+)\s*$/m.exec(text);
  assert.ok(m, "spec/openapi.yaml: could not find info.version");
  const major = /^(\d+)\./.exec(m[1]);
  assert.ok(major, `spec/openapi.yaml: info.version "${m[1]}" is not semver-shaped`);
  return Number(major[1]);
}

const openApiPaths = loadOpenApiPaths(openapiText);
const openApiVersionMajor = loadOpenApiVersionMajor(openapiText);

// --- nodes/*.js + lib/*.js: REST path literal scanner ------------------

const SOURCE_DIRS = ["nodes", "lib"];

function listSourceFiles() {
  const files = [];
  for (const dir of SOURCE_DIRS) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith(".js")) files.push(path.join(dir, name));
    }
  }
  return files;
}

// String literals that start with "/" but are not openccu-loom REST
// paths, with the reason each is not one.
const IGNORED_LITERALS = new Set([
  // nodes/openccu-loom-api.js: a bare "/" is used as a prefix-normalization
  // literal (`path.startsWith("/")` / `"/" + path`), not an endpoint.
  "/",
  // nodes/openccu-loom-server.js: a Node-RED *admin* HTTP route
  // (RED.httpAdmin.post) backing the editor's "test connection" button.
  // It is served by Node-RED itself, not the openccu-loom daemon, so it
  // has no entry in the daemon's openapi.yaml.
  "/openccu-loom/test-connection",
]);

// ${...} interpolations (encodeURIComponent(x), nested calls, even ones
// that wrap onto another line) become the generic "{param}" marker.
function normalizeTemplate(raw) {
  return raw.replace(/\$\{[^}]*\}/g, "{param}");
}

// Collects raw path candidates from one file's source text:
//  - double-quoted string literals starting with "/"
//  - template literals starting with "`/" (normalized via normalizeTemplate)
//  - template literals that build a full URL via a scheme://host:port
//    prefix (lib/client.js buildBaseURL/buildWSURL) — these do not start
//    with "/" themselves, so the static suffix after the LAST ${...}
//    placeholder is taken instead, when that suffix starts with "/". The
//    "://" marker scopes this fallback to actual origin-building
//    templates; without it, a path-building template that merely starts
//    with a variable (e.g. `${base}/${id}/ack`) would wrongly contribute
//    only its last static fragment instead of being skipped.
function extractPathCandidates(src) {
  const out = [];
  for (const m of src.matchAll(/"([^"]*)"/g)) {
    if (m[1].startsWith("/")) out.push(m[1]);
  }
  for (const m of src.matchAll(/`([^`]*)`/g)) {
    const raw = m[1];
    if (raw.startsWith("/")) {
      out.push(normalizeTemplate(raw));
      continue;
    }
    if (!raw.includes("://")) continue;
    const lastPlaceholder = raw.lastIndexOf("${");
    if (lastPlaceholder === -1) continue;
    const closeIdx = raw.indexOf("}", lastPlaceholder);
    if (closeIdx === -1) continue;
    const trailing = raw.slice(closeIdx + 1);
    if (trailing.startsWith("/")) out.push(trailing);
  }
  return out;
}

// Every REST call in nodes/*.js and lib/*.js goes through a client whose
// baseURL already carries "/api/v1" (lib/client.js buildBaseURL), so the
// paths collected above are relative ("/info", not "/api/v1/info") —
// except the two literal absolute-URL builders in lib/client.js
// (buildBaseURL, buildWSURL), which spell the "/api/v1" prefix out by
// hand. Strip it here so every candidate lands in the same
// (openapi-relative) space; a candidate that is nothing *but* the
// prefix is the base URL itself, not a resource path, and normalizes to
// null.
function toApiRelative(p) {
  const PREFIX = "/api/v1";
  if (p === PREFIX) return null;
  if (p.startsWith(PREFIX + "/")) return p.slice(PREFIX.length);
  return p;
}

function segmentMatches(candidateSeg, specSeg) {
  if (/^\{.+\}$/.test(specSeg)) return candidateSeg === "{param}";
  return candidateSeg === specSeg;
}

function pathExistsInSpec(candidate, specPaths) {
  const a = candidate.split("/");
  return specPaths.some((sp) => {
    const b = sp.split("/");
    return a.length === b.length && a.every((seg, i) => segmentMatches(seg, b[i]));
  });
}

function collectCandidates(relFile) {
  const src = fs.readFileSync(path.join(ROOT, relFile), "utf8");
  return extractPathCandidates(src)
    .filter((raw) => !IGNORED_LITERALS.has(raw))
    .map((raw) => ({ raw, normalized: toApiRelative(raw) }))
    .filter((c) => c.normalized !== null && !IGNORED_LITERALS.has(c.normalized));
}

describe("API-PIN contract: REST paths used by nodes/lib exist in the vendored OpenAPI spec", function () {
  it("every collected REST path literal matches a vendored spec/openapi.yaml path", function () {
    const missing = [];
    for (const rel of listSourceFiles()) {
      for (const { raw, normalized } of collectCandidates(rel)) {
        if (!pathExistsInSpec(normalized, openApiPaths)) {
          missing.push(`${rel}: "${raw}" (normalized "${normalized}") has no match in spec/openapi.yaml`);
        }
      }
    }
    assert.deepStrictEqual(missing, [], `Found path(s) with no vendored-spec match:\n${missing.join("\n")}`);
  });

  it("sanity: the WS events path and /auth/login are actually covered by the scanner", function () {
    const candidates = collectCandidates("lib/client.js").map((c) => c.normalized);
    assert.ok(candidates.includes("/events"), "scanner did not pick up the WS URL's /api/v1/events suffix");
    assert.ok(candidates.includes("/auth/login"), "scanner did not pick up /auth/login");
  });
});

describe("API-PIN contract: alarm node commands + hub envelope ops", function () {
  const alarmNode = require("../nodes/openccu-loom-alarm.js");
  const { ALARM_COMMANDS } = alarmNode;

  it("exports commands, and every one of them exists in wsapi.json commands[].name", function () {
    assert.ok(ALARM_COMMANDS && Object.keys(ALARM_COMMANDS).length > 0, "ALARM_COMMANDS is missing or empty");
    const known = new Set(wsapi.commands.map((c) => c.name));
    for (const [action, command] of Object.entries(ALARM_COMMANDS)) {
      assert.ok(known.has(command), `ALARM_COMMANDS.${action} = "${command}" is not in wsapi.json commands[].name`);
    }
  });

  it("every ARG_NAMES entry matches the command's args in wsapi.json verbatim", function () {
    const { ARG_NAMES } = alarmNode;
    assert.ok(ARG_NAMES && Object.keys(ARG_NAMES).length > 0, "ARG_NAMES is missing or empty");
    const byName = new Map(wsapi.commands.map((c) => [c.name, c]));
    for (const [command, names] of Object.entries(ARG_NAMES)) {
      const cmd = byName.get(command);
      assert.ok(cmd, `ARG_NAMES pins unknown command "${command}"`);
      const specArgs = new Set(Object.keys(cmd.args || {}));
      for (const name of names) {
        assert.ok(
          specArgs.has(name),
          `ARG_NAMES["${command}"] uses arg "${name}" which wsapi.json does not define (has: ${[...specArgs].join(", ")})`
        );
      }
    }
  });

  it("the envelope control ops the hub relies on are documented in the wsapi spec text", function () {
    // lib/ws-hub.js switches on these literal op values while framing /
    // parsing every WebSocket message (subscribe ack, replay markers,
    // heartbeat, call result). Each must appear somewhere in the
    // vendored wsapi.json so a spec refresh that silently drops one is
    // caught here.
    const ops = ["subscribed", "unsubscribed", "replay_done", "replay_lost", "ping", "pong", "result"];
    for (const op of ops) {
      assert.ok(wsapiText.includes(op), `wsapi.json does not mention the "${op}" envelope op anywhere`);
    }
  });

  it("known spec gap: reauth is a real op the hub relies on but wsapi.json does not document it yet", function () {
    // lib/ws-hub.js sends {op:"reauth", token} (see WsHub.reauth()), and
    // the daemon really implements it — openccu-loom's
    // internal/north/rest/ws/client.go reauth()/handleFrame() replies
    // with {op:"reauth_ok"|"reauth_failed"} — but this vendored
    // wsapi.json's envelope/resume/heartbeat/subscription_ack sections
    // document subscribe/unsubscribe/ping/pong/replay only, not reauth.
    // This is a real gap in the daemon's spec documentation, not a bug
    // in this package. Tracked here instead of silently asserting
    // something false: if the daemon repo starts documenting "reauth",
    // this assertion flips and should be merged into the op list above.
    assert.ok(
      !wsapiText.includes("reauth"),
      'wsapi.json now documents "reauth" — move it into the asserted envelope-op list above'
    );
  });
});

describe("API-PIN contract: SUPPORTED_API_MAJOR tracks the vendored spec", function () {
  it("lib/client.js SUPPORTED_API_MAJOR equals the vendored openapi.yaml info.version major", function () {
    const { SUPPORTED_API_MAJOR } = require("../lib/client");
    assert.strictEqual(
      SUPPORTED_API_MAJOR,
      openApiVersionMajor,
      `lib/client.js SUPPORTED_API_MAJOR (${SUPPORTED_API_MAJOR}) must equal the vendored ` +
        `spec/openapi.yaml info.version major (${openApiVersionMajor}) — bump one to match the ` +
        "other after a conscious compatibility review, then refresh spec/ from the daemon repo."
    );
  });
});
