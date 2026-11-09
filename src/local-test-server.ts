import { config } from './config.js';

if (config().production) throw new Error('本地测试启动命令不能用于生产环境。');
process.env.ENABLE_TEST_TOOLS = 'true';
await import('./server.js');
