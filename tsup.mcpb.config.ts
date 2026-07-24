import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { 'server/index': 'src/index.ts' },
  outDir: 'mcpb-src',
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  noExternal: [/.*/],
  clean: false,
  banner: { js: '#!/usr/bin/env node' },
});
