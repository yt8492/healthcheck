import { runNode, exitCode, emulatorEnv } from './process.js';

const child = runNode(['node_modules/firebase-tools/lib/bin/firebase.js', 'emulators:exec', '--only', 'firestore', '--project', 'demo-healthcheck', 'npm run test:integration'], {
  ...emulatorEnv(), GOOGLE_CLOUD_PROJECT: 'demo-healthcheck',
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal));
process.exitCode = await exitCode(child);
