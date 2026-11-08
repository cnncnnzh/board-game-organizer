import { config } from './config.js';
import { openDatabase, migrate } from './db.js';
const settings = config();
const db = await openDatabase({ url: settings.databaseUrl, dataDir: settings.dataDir });
try { await migrate(db); console.log('Database migrations complete'); }
finally { await db.close(); }
