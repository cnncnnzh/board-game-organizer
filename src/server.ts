import { buildApp } from './app.js';
import { config } from './config.js';

const settings = config();
const app = await buildApp({ logger: true });
let running = false;
async function housekeeping() {
  if (running) return;
  running = true;
  try {
    const result = await app.service.runHousekeeping();
    if (result.finalized.length || result.deleted.length) app.log.info(result, 'Housekeeping complete');
  } catch (error) { app.log.error(error, 'Housekeeping failed; will retry'); }
  finally { running = false; }
}
await housekeeping();
const timer = setInterval(() => void housekeeping(), settings.housekeepingInterval);
timer.unref();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => {
  clearInterval(timer);
  await app.close();
});
await app.listen({ host: settings.host, port: settings.port });
console.log(`Local: http://${settings.host === '0.0.0.0' ? 'localhost' : settings.host}:${settings.port}`);
console.log(`Database: ${app.db.kind}; test tools: ${settings.testTools ? 'enabled' : 'disabled'}`);
