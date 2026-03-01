import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/gateway/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/gateway/index.js',
  sourcemap: true,
  // Mark node_modules as external to avoid bundling them
  packages: 'external',
  // Banner to support __dirname in ESM
  banner: {
    js: `
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
`,
  },
})
