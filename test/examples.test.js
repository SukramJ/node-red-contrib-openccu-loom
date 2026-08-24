"use strict";

// Packaging contract for examples/: the flows shipped in the palette's
// "Import → Examples" menu must actually be importable and must reference
// this package's nodes the way the editor defines them. A typo in a
// property name or an action value is invisible until someone imports the
// flow and it silently does nothing, so it is pinned here instead.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EXAMPLES_DIR = path.join(ROOT, "examples");
const NODES_DIR = path.join(ROOT, "nodes");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const REGISTERED = new Set(Object.keys(pkg["node-red"].nodes));

// Properties every Node-RED node carries regardless of its own defaults:
// the runtime's own bookkeeping plus the editor's layout fields.
const RUNTIME_PROPS = new Set(["id", "type", "z", "g", "name", "x", "y", "wires", "d", "info", "l", "credentials"]);

// --- nodes/*.html: the editor's own definition of each node -------------
//
// registerType's `defaults` object names every property the editor stores,
// and the action/scope <select> lists every value it offers. Both are read
// straight from the source of truth rather than restated here.

function readNodeHtml(type) {
  return fs.readFileSync(path.join(NODES_DIR, `${type}.html`), "utf8");
}

function defaultsOf(type) {
  const html = readNodeHtml(type);
  const block = /defaults:\s*\{([\s\S]*?)\n {4}\},/.exec(html);
  assert.ok(block, `${type}.html: could not find the defaults block`);
  const keys = new Set();
  for (const m of block[1].matchAll(/^\s{6}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)) keys.add(m[1]);
  assert.ok(keys.size > 0, `${type}.html: defaults block parsed as empty`);
  return keys;
}

// The values of one <select> in the edit template, keyed by the input id
// ("node-input-action" → the action values). Returns null when the node has
// no such select, which means the property is free text.
function selectValues(type, inputId) {
  const html = readNodeHtml(type);
  const sel = new RegExp(`<select id="${inputId}">([\\s\\S]*?)</select>`).exec(html);
  if (!sel) return null;
  const values = new Set();
  for (const m of sel[1].matchAll(/<option value="([^"]*)"/g)) {
    if (m[1] !== "") values.add(m[1]);
  }
  return values.size > 0 ? values : null;
}

const files = fs
  .readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("examples/", function () {
  it("ships at least one importable flow", function () {
    assert.ok(files.length > 0, "examples/ is empty");
  });

  it("is the directory package.json points the editor at", function () {
    assert.strictEqual(pkg["node-red"].examples, "examples");
  });

  for (const file of files) {
    describe(file, function () {
      const flow = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, file), "utf8"));

      it("is a flat array of nodes carrying id and type", function () {
        assert.ok(Array.isArray(flow), "a flow export is a JSON array");
        for (const node of flow) {
          assert.ok(node && typeof node === "object", "every entry is an object");
          assert.ok(node.id, `a node without an id: ${JSON.stringify(node).slice(0, 80)}`);
          assert.ok(node.type, `node ${node.id} has no type`);
        }
      });

      it("has unique node ids", function () {
        const seen = new Set();
        for (const node of flow) {
          assert.ok(!seen.has(node.id), `duplicate node id ${node.id}`);
          seen.add(node.id);
        }
      });

      it("wires only to nodes that exist in the same flow", function () {
        const ids = new Set(flow.map((n) => n.id));
        for (const node of flow) {
          for (const port of node.wires || []) {
            for (const target of port) {
              assert.ok(ids.has(target), `${node.id} wires to unknown node ${target}`);
            }
          }
        }
      });

      it("places every wired node on a tab declared in the flow", function () {
        const tabs = new Set(flow.filter((n) => n.type === "tab").map((n) => n.id));
        for (const node of flow) {
          // Config nodes (the server) are flow-global and carry no z.
          if (node.type === "tab" || node.type === "openccu-loom-server") continue;
          assert.ok(tabs.has(node.z), `${node.id} sits on unknown tab ${node.z}`);
        }
      });

      it("uses only openccu-loom nodes this package registers", function () {
        for (const node of flow) {
          if (!node.type.startsWith("openccu-loom")) continue;
          assert.ok(REGISTERED.has(node.type), `${node.type} is not registered in package.json`);
        }
      });

      it("points every node at a server config node in the same flow", function () {
        const servers = new Set(flow.filter((n) => n.type === "openccu-loom-server").map((n) => n.id));
        for (const node of flow) {
          if (!node.type.startsWith("openccu-loom") || node.type === "openccu-loom-server") continue;
          assert.ok(node.server, `${node.id} (${node.type}) has no server reference`);
          assert.ok(servers.has(node.server), `${node.id} references unknown server ${node.server}`);
        }
      });

      it("reaches the daemon on its documented default port", function () {
        for (const node of flow) {
          if (node.type !== "openccu-loom-server") continue;
          // 8119 has been the daemon's single REST/WS/UI port since 0.3.0;
          // an example still on the old 8080 would not connect.
          assert.strictEqual(node.port, 8119, `${node.id} uses port ${node.port}, not the default 8119`);
        }
      });

      it("sets only properties the node's editor defines", function () {
        for (const node of flow) {
          if (!node.type.startsWith("openccu-loom")) continue;
          const allowed = defaultsOf(node.type);
          for (const key of Object.keys(node)) {
            if (RUNTIME_PROPS.has(key)) continue;
            assert.ok(
              allowed.has(key),
              `${node.id} (${node.type}) sets "${key}", which is not in that node's defaults`
            );
          }
        }
      });

      it("uses action/scope values the node's editor offers", function () {
        for (const node of flow) {
          if (!node.type.startsWith("openccu-loom")) continue;
          for (const prop of ["action", "scope", "mode", "kind"]) {
            if (node[prop] == null || node[prop] === "") continue;
            const offered = selectValues(node.type, `node-input-${prop}`);
            if (!offered) continue; // free-text field, nothing to pin
            assert.ok(
              offered.has(node[prop]),
              `${node.id} (${node.type}) sets ${prop}="${node[prop]}", which the editor does not offer`
            );
          }
        }
      });
    });
  }

  it("documents every shipped flow in the README", function () {
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const undocumented = files.filter((f) => !readme.includes(f));
    assert.deepStrictEqual(undocumented, [], `not mentioned in README.md: ${undocumented.join(", ")}`);
  });
});
