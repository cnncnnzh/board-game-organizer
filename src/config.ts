import { resolve } from 'node:path';

try { process.loadEnvFile('.env'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

export function config() {
  const production = process.env.NODE_ENV === 'production';
  const databaseUrl = process.env.DATABASE_URL || undefined;
  if (production && !databaseUrl) throw new Error('生产环境必须设置 DATABASE_URL，PGlite 仅用于本地开发。');
  const origin = process.env.PUBLIC_ORIGIN || 'http://localhost:3000';
  const parsed = new URL(origin);
  if (parsed.origin !== origin) throw new Error('PUBLIC_ORIGIN 必须是完整 origin，不带路径或末尾斜线。');
  if (production && parsed.protocol !== 'https:') throw new Error('生产环境 PUBLIC_ORIGIN 必须使用 HTTPS。');
  return {
    production, databaseUrl, publicOrigin: origin,
    dataDir: resolve(process.env.DATA_DIR || 'data/board-games'),
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 3000),
    sessionDays: Math.min(365, Math.max(1, Number(process.env.SESSION_DAYS || 180))),
    testTools: !production && process.env.ENABLE_TEST_TOOLS === 'true',
    housekeepingInterval: Math.max(1000, Number(process.env.HOUSEKEEPING_INTERVAL_MS || 300000)),
  };
}
