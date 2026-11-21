import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: { 'api/server': 'apps/api/src/server.ts', 'sync/cli': 'apps/sync/src/cli.ts' },
  outdir: 'dist', bundle: true, platform: 'node', target: 'node24', format: 'esm',
  external: Object.keys(manifest.dependencies), sourcemap: true,
});
if (!process.argv.includes('--api-only')) {
  const result = spawnSync(process.execPath, ['scripts/web.mjs', 'build'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
