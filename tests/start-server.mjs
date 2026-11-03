import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'razem-e2e-'));
const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
  stdio: 'inherit', env: { ...process.env, HOST: '127.0.0.1', PORT: '4317', NODE_ENV: 'production', DATABASE_PATH: resolve(directory, 'test.sqlite') },
});
process.once('SIGTERM', () => child.kill('SIGTERM'));
process.once('SIGINT', () => child.kill('SIGINT'));
child.once('exit', async (code) => { await rm(directory, { recursive: true, force: true }); process.exitCode = code ?? 1; });
