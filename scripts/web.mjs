import { spawn } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = join(root, 'apps/web');
const mode = process.argv[2] ?? 'build';
const tasks = {
  build: ['wasmJsBrowserDistribution'],
  dev: ['wasmJsBrowserDevelopmentRun', '--continuous'],
  check: ['compileKotlinWasmJs', 'compileTestKotlinWasmJs'],
  test: ['wasmJsBrowserTest'],
};
if (!tasks[mode]) throw new Error(`Unknown web command: ${mode}`);
const env = { ...process.env };
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!env.CHROME_BIN && existsSync(chrome)) env.CHROME_BIN = chrome;
const windows = process.platform === 'win32';
const child = spawn(join(project, windows ? 'gradlew.bat' : 'gradlew'), [...tasks[mode], '--console=plain'], {
  cwd: project, env, stdio: 'inherit', shell: windows,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1)));
});
if (code !== 0) process.exit(code);
if (mode === 'build') {
  const output = join(root, 'dist/web');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(join(project, 'build/dist/wasmJs/productionExecutable'), output, { recursive: true });
  console.log('Built Compose Web in dist/web.');
}
