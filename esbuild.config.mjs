import * as esbuild from 'esbuild'

const sharedConfig = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // Mark node_modules as external to avoid bundling them
  packages: 'external',
  // Banner to support __dirname in ESM. The imports are aliased because the
  // banner is raw text esbuild cannot rename, so a bundled module importing
  // `dirname` or `fileURLToPath` at the top level would otherwise collide.
  banner: {
    js: `
import { fileURLToPath as __bannerFileURLToPath } from 'url';
import { dirname as __bannerDirname } from 'path';
const __filename = __bannerFileURLToPath(import.meta.url);
const __dirname = __bannerDirname(__filename);
`,
  },
}

// Main gateway bundle
await esbuild.build({
  ...sharedConfig,
  entryPoints: ['src/gateway/index.ts'],
  outfile: 'dist/gateway/index.js',
})
