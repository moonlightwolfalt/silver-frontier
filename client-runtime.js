// Loads top-level definitions out of the fetched mope.io client bundle so the local game server
// can use the client's own protocol code (bit reader/writer, message schemas, animal table)
// instead of a hand-written copy that could drift from it.
//
// Each definition is evaluated lazily, on first use, inside a vm context; any other top-level
// name it refers to is loaded the same way. Only plain data and codec code is ever run here:
// rendering classes may get *defined* when a dependency chain pulls them in, but are never called.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import * as acorn from "acorn";

export function findClientChunk(clientDir, marker) {
  for (const f of fs.readdirSync(clientDir, { recursive: true })) {
    if (!f.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(clientDir, f), "utf8");
    if (src.includes(marker)) return src;
  }
  throw new Error(`no client chunk containing ${JSON.stringify(marker)} in ${clientDir}`);
}

export function loadClient(src) {
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" });
  const decls = new Map();
  for (const node of ast.body) {
    if (node.type === "VariableDeclaration") {
      for (const d of node.declarations)
        if (d.id.type === "Identifier" && d.init) decls.set(d.id.name, src.slice(d.init.start, d.init.end));
    } else if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) {
      decls.set(node.id.name, src.slice(node.start, node.end));
    }
  }

  const values = new Map();
  const loading = new Set();
  // Binary types come from this realm, so the client's `instanceof ArrayBuffer` checks accept
  // buffers created by Node (e.g. WebSocket frames).
  const context = vm.createContext({
    console, performance, TextEncoder, TextDecoder, Math, Date,
    ArrayBuffer, SharedArrayBuffer, DataView, Uint8Array, Int8Array, Uint16Array, Int16Array,
    Uint32Array, Int32Array, Float32Array, Float64Array,
    // the patched client builds some URLs from location.origin at load time
    location: { origin: "", href: "", hostname: "localhost" },
  });
  const resolve = (name) => {
    if (values.has(name)) return values.get(name);
    if (loading.has(name)) throw new Error(`circular dependency while loading ${name}`);
    loading.add(name);
    try {
      const fn = vm.runInContext(`(function () { with (__scope) { return (${decls.get(name)}); } })`, context);
      const value = fn();
      values.set(name, value);
      return value;
    } finally {
      loading.delete(name);
    }
  };
  context.__scope = new Proxy(Object.create(null), {
    has: (_, key) => typeof key === "string" && decls.has(key),
    get: (_, key) => (key === Symbol.unscopables ? undefined : resolve(key)),
    set: (_, key, value) => (values.set(key, value), true),
  });

  return { get: resolve, has: (name) => decls.has(name) };
}
