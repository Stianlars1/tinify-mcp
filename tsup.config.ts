import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  sourcemap: false,
  clean: true,
  dts: false,
  // Bundle the Tinify.dev SDK so the published package works standalone with
  // `npx -y @tinify-dev/mcp` even before/without the SDK being installed.
  noExternal: ["@tinify-dev/client"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
