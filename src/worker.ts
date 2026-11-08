import { config } from './config.js';
import { openDatabase, migrate } from './db.js';
import { EventService } from './service.js';

const settings = config();
if (!settings.databaseUrl) throw new Error('独立 worker 需要 DATABASE_URL。本地 PGlite 模式的定时任务已包含在 API 进程中，请勿同时打开相同数据目录。');
const db = await openDatabase({ url: settings.databaseUrl });
await migrate(db);
const service = new EventService(db);
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { console.log(JSON.stringify({ time: new Date().toISOString(), ...await service.runHousekeeping() })); }
  catch (error) { console.error('Housekeeping failed; will retry', error); }
  finally { running = false; }
}
await tick();
const timer = setInterval(() => void tick(), settings.housekeepingInterval);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { clearInterval(timer); await db.close(); });
