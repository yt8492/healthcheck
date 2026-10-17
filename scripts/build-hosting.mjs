import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const args of [['run', 'build'], ['run', 'build:site']]) {
  const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const output = join(root, 'dist/hosting');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// Only built browser assets and explicitly listed public pages reach Hosting.
// Server bundles, credentials, and health data stay outside this directory.
await cp(join(root, 'dist/web'), output, { recursive: true });
for (const file of ['about', 'privacy', 'terms', 'styles.css', 'favicon.svg', 'robots.txt', 'sitemap.xml']) {
  await cp(join(root, 'site/dist', file), join(output, file), { recursive: true });
}
console.log(`Built dashboard and public pages in dist/hosting (${(await readdir(output)).join(', ')}).`);
