import assert from "node:assert/strict";
import module, { registerHooks, syncBuiltinESMExports } from "node:module";

let enabled = false;
let runtimeLoaded = false;
const enable = module.enableCompileCache;
module.enableCompileCache = (...args) => {
  assert.deepEqual(args, []);
  const result = enable(...args);
  enabled = true;
  return result;
};
syncBuiltinESMExports();
registerHooks({
  load(url, context, nextLoad) {
    if (url.includes("/dist/") && !url.endsWith("/web/serve.js")) {
      assert(enabled, `Runtime loaded before enabling compile cache: ${url}`);
      runtimeLoaded = true;
    }
    return nextLoad(url, context);
  },
});
process.on("exit", () => {
  assert(enabled);
  assert(runtimeLoaded);
});
