import { build } from 'esbuild';
import { build as buildWeb } from 'vite';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: { 'api/server': 'apps/api/src/server.ts', 'sync/cli': 'apps/sync/src/cli.ts' },
  outdir: 'dist', bundle: true, platform: 'node', target: 'node24', format: 'esm',
  external: Object.keys(manifest.dependencies), sourcemap: true,
});
await buildWeb({ configFile: 'apps/web/vite.config.ts' });
