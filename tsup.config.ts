import { defineConfig } from 'tsup';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  entry: ['src/boot.ts', 'src/server.ts', 'src/hook.ts', 'src/migrate.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
  // Resolved at runtime from node_modules (large packages / native binaries):
  external: ['@huggingface/transformers', 'onnxruntime-node', 'sharp', 'sqlite-vec'],
  splitting: false,
  sourcemap: true,
  minify: false,
});
