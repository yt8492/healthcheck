import { runNode, exitCode } from './process.js';

const env = { ...process.env, HOST: process.env.HOST ?? '127.0.0.1' };
const children = [runNode(['--import', 'tsx', 'apps/api/src/server.ts'], env),
  runNode(['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts'], env)];
let stopping = false;
const stop = () => { if (!stopping) { stopping = true; for (const child of children) child.kill('SIGTERM'); } };
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop);
const codes = children.map(child => exitCode(child).then(code => { stop(); return code; }));
process.exitCode = (await Promise.all(codes)).find(code => code !== 0) ?? 0;
