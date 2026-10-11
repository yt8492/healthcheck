import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

export function runNode(args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  return spawn(process.execPath, args, { stdio: 'inherit', env });
}
export function exitCode(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
}
export const emulatorEnv = (): NodeJS.ProcessEnv => ({ ...process.env,
  FIREBASE_EMULATORS_PATH: resolve('.cache/emulators'), XDG_CONFIG_HOME: resolve('.cache/config'),
  FIREBASE_CLI_DISABLE_UPDATE_CHECK: '1',
});
