import { defineConfig } from "tsup";

// Fully-bundled remote (streamable-HTTP) build: deploy = this one file + node.
// Mirrors tsup.mcpb.config.ts (noExternal everything, CJS, node20, shebang).
export default defineConfig({
  entry: { http: "src/http.ts" },
  outDir: "dist-remote",
  format: ["cjs"],
  platform: "node",
  target: "node20",
  noExternal: [/.*/],
  clean: true,
  sourcemap: false,
  dts: false,
  // import.meta.url is used for the "run directly?" check; shims map it to
  // pathToFileURL(__filename) in the CJS bundle.
  shims: true,
  banner: { js: "#!/usr/bin/env node" },
});
