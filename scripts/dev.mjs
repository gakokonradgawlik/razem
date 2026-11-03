import { spawn } from 'node:child_process';

const build = spawn('npm', ['run', 'build', '-w', '@razem/contracts'], { stdio: 'inherit' });
const status = await new Promise((resolve) => build.once('exit', resolve));
if (status !== 0) process.exit(status ?? 1);
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
for (const [args, cwd] of [
  [['--env-file-if-exists=.env', '--conditions=development', '--import=tsx', '--watch', 'apps/server/src/index.ts'], '.'],
  [['--env-file-if-exists=.env', '--conditions=development', '--import=tsx', '--watch', 'apps/worker/src/index.ts'], '.'],
  [['../../node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], 'apps/web'],
]) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', cwd });
  children.push(child);
  child.once('error', () => stop(1));
  child.once('exit', (code) => stop(code ?? 0));
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
