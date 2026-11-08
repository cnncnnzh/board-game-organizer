/**
 * Optional real PostgreSQL integration runner; never installs a service or OS account.
 * Windows setup: npm install --prefix .tools/postgres --no-audit --no-fund @embedded-postgres/windows-x64
 * Or set POSTGRES_BIN to an existing PostgreSQL bin directory. All cluster data stays under .tools.
 */
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve, relative, isAbsolute } from 'node:path';
import pg from 'pg';

const root = resolve('.');
const suffix = process.platform === 'win32' ? '.exe' : '';
const packagePlatform = process.platform === 'win32' ? 'windows' : process.platform;
const bin = resolve(process.env.POSTGRES_BIN ?? `.tools/postgres/node_modules/@embedded-postgres/${packagePlatform}-${process.arch}/native/bin`);
const initdb = resolve(bin, `initdb${suffix}`);
const postgres = resolve(bin, `postgres${suffix}`);
const pgctl = resolve(bin, `pg_ctl${suffix}`);
try { await Promise.all([initdb, postgres, pgctl].map((path) => access(path))); }
catch {
  console.log('SKIP: PostgreSQL binaries not found. Set POSTGRES_BIN or install @embedded-postgres/windows-x64 under .tools/postgres.');
  process.exit(0);
}

function run(file, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, { cwd: root, windowsHide: true, ...options });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun(output.trim());
      else reject(new Error(`${file} exited ${code ?? signal}\n${output}`));
    });
  });
}
async function freePort() {
  const listener = createServer();
  await new Promise((resolvePort, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolvePort); });
  const port = listener.address().port;
  await new Promise((resolveClose, reject) => listener.close((error) => error ? reject(error) : resolveClose()));
  return port;
}
const runBase = resolve('.tools/postgres/runs');
const runDir = resolve(runBase, `${Date.now()}-${randomUUID().slice(0, 8)}`);
const pathWithinRunBase = relative(runBase, runDir);
if (!pathWithinRunBase || pathWithinRunBase.startsWith('..') || isAbsolute(pathWithinRunBase)) throw new Error('Invalid isolated test directory');
const dataDir = resolve(runDir, 'data');
await mkdir(runDir, { recursive: true });
const port = await freePort();
const adminUrl = `postgresql://board_game_test@127.0.0.1:${port}/postgres`;
const testUrl = `postgresql://board_game_test@127.0.0.1:${port}/board_game_integration`;
let server;
const log = createWriteStream(resolve(runDir, 'postgres.log'));
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  if (server && server.exitCode === null) {
    try { await run(pgctl, ['-D', dataDir, 'stop', '-m', 'fast', '-w', '-t', '15']); }
    catch (error) { server.kill(); throw error; }
  }
  log.end();
}
try {
  const version = await run(postgres, ['--version']);
  console.log(`Testing with ${version} on loopback port ${port}`);
  const initialized = await run(initdb, ['-D', dataDir, '--username=board_game_test', '--auth=trust', '--encoding=UTF8', '--locale=C']);
  await writeFile(resolve(runDir, 'initdb.log'), initialized);
  server = spawn(postgres, ['-D', dataDir, '-h', '127.0.0.1', '-p', String(port), '-c', 'max_connections=30', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.pipe(log, { end: false });
  server.stderr.pipe(log, { end: false });
  let processError;
  server.once('error', (error) => { processError = error; });
  const deadline = Date.now() + 20000;
  let connected = false;
  while (Date.now() < deadline) {
    if (processError) throw processError;
    if (server.exitCode !== null) throw new Error(`PostgreSQL exited early; inspect ${resolve(runDir, 'postgres.log')}`);
    const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 700 });
    try {
      await client.connect();
      await client.query('CREATE DATABASE board_game_integration');
      connected = true;
      break;
    } catch (error) {
      if (Date.now() + 200 >= deadline) throw error;
      await new Promise((resume) => setTimeout(resume, 150));
    } finally { await client.end().catch(() => {}); }
  }
  if (!connected) throw new Error('Timed out waiting for isolated PostgreSQL');
  const tests = (await readdir(resolve('test'))).filter((file) => file.endsWith('.test.ts')).map((file) => resolve('test', file));
  await run(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), '--test', '--test-concurrency=1', ...tests], {
    env: { ...process.env, TEST_DATABASE_URL: testUrl }, stdio: 'inherit',
  });
  console.log('Real PostgreSQL integration suite passed. Cluster logs/data retained in ignored .tools/postgres/runs for inspection.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally { await stop(); }
