import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';

const ENV_KEYS = ['NODE_ENV', 'DATABASE_URL', 'PUBLIC_ORIGIN', 'RENDER_EXTERNAL_URL', 'ENABLE_TEST_TOOLS'] as const;
type EnvKey = typeof ENV_KEYS[number];
const DATABASE_URL = 'postgresql://config-test@127.0.0.1:5432/config-test';
const RENDER_URL = 'https://board-game-config-test.onrender.com';

async function withEnv<T>(values: Partial<Record<EnvKey, string>>, callback: () => T | Promise<T>): Promise<T> {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    return await callback();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('Render production starts without manually specifying PUBLIC_ORIGIN', async () => {
  await withEnv({ NODE_ENV: 'production', DATABASE_URL, RENDER_EXTERNAL_URL: RENDER_URL }, () => {
    assert.equal(config().publicOrigin, RENDER_URL);
    assert.equal(config().production, true);
  });
});

test('explicit custom domain takes precedence over the Render URL', async () => {
  await withEnv({ NODE_ENV: 'production', DATABASE_URL, PUBLIC_ORIGIN: 'https://games.example.com', RENDER_EXTERNAL_URL: RENDER_URL }, () => {
    assert.equal(config().publicOrigin, 'https://games.example.com');
  });
});

test('empty PUBLIC_ORIGIN falls back to the Render URL', async () => {
  await withEnv({ NODE_ENV: 'production', DATABASE_URL, PUBLIC_ORIGIN: '', RENDER_EXTERNAL_URL: RENDER_URL }, () => {
    assert.equal(config().publicOrigin, RENDER_URL);
  });
});

test('local development keeps its localhost default without a Render URL', async () => {
  await withEnv({ NODE_ENV: 'development' }, () => {
    assert.equal(config().publicOrigin, 'http://localhost:3000');
    assert.equal(config().databaseUrl, undefined);
  });
});

test('production still rejects insecure or malformed Render origins', async () => {
  for (const origin of ['http://board-game-config-test.onrender.com', `${RENDER_URL}/`, `${RENDER_URL}/events`]) {
    await withEnv({ NODE_ENV: 'production', DATABASE_URL, RENDER_EXTERNAL_URL: origin }, () => {
      assert.throws(() => config(), /PUBLIC_ORIGIN/);
    });
  }
});

test('production still requires an external database and an HTTPS origin', async () => {
  await withEnv({ NODE_ENV: 'production', RENDER_EXTERNAL_URL: RENDER_URL }, () => {
    assert.throws(() => config(), /DATABASE_URL/);
  });
  await withEnv({ NODE_ENV: 'production', DATABASE_URL }, () => {
    assert.throws(() => config(), /HTTPS/);
  });
});

test('Render-derived origin accepts browser writes and issues production Secure cookies', async () => {
  await withEnv({ NODE_ENV: 'production', DATABASE_URL, RENDER_EXTERNAL_URL: RENDER_URL, ENABLE_TEST_TOOLS: 'true' }, async () => {
    const db = await openDatabase();
    const app = await buildApp({ db, logger: false });
    try {
      const startAt = Date.now() + 2 * 86400000;
      const created = await app.inject({
        method: 'POST', url: '/api/v1/events',
        headers: { origin: RENDER_URL, 'content-type': 'application/json' },
        payload: {
          displayName: 'Render 启动测试', title: '自动识别公网地址', location: '测试地点',
          startAt: new Date(startAt).toISOString(), endAt: new Date(startAt + 4 * 3600000).toISOString(),
          timeZone: 'America/Chicago',
        },
      });
      assert.equal(created.statusCode, 200);
      assert.equal(created.json().data.event.role, 'owner');
      const header = created.headers['set-cookie'];
      const cookies = Array.isArray(header) ? header.join('; ') : String(header ?? '');
      assert.match(cookies, /(?:^|;\s*)Secure(?:;|$)/i);
      assert.match(cookies, /(?:^|;\s*)HttpOnly(?:;|$)/i);
      assert.equal(app.service.testTools, false);

      const crossSite = await app.inject({
        method: 'POST', url: '/api/v1/session',
        headers: { origin: 'https://another-site.example.com', 'content-type': 'application/json' },
        payload: { displayName: '跨站请求' },
      });
      assert.equal(crossSite.statusCode, 403);
      assert.equal(crossSite.json().error.code, 'CSRF_REJECTED');
    } finally { await app.close(); }
  });
});
