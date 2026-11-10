import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { openDatabase, migrate, type Database, type Row } from './db.js';
import { config } from './config.js';
import { IdentityService, type Actor } from './identity.js';
import { EventService } from './service.js';
import { AppError, assert } from './domain/validation.js';
import { buildOpenApi } from './openapi.js';

declare module 'fastify' {
  interface FastifyInstance { service: EventService; db: Database }
  interface FastifyRequest { actor: Actor | null }
}
export async function buildApp(options: {
  db?: Database; now?: () => number; testTools?: boolean; logger?: boolean; publicOrigin?: string;
} = {}) {
  const settings = config();
  const db = options.db ?? await openDatabase({ url: settings.databaseUrl, dataDir: settings.dataDir });
  try { await migrate(db); } catch (error) { await db.close(); throw error; }
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16384, requestTimeout: 15000 });
  app.decorate('db', db);
  app.decorate('service', new EventService(db, options.now, options.testTools ?? settings.testTools));
  app.decorateRequest('actor', null);
  const identity = new IdentityService(db, settings.sessionDays);
  const publicOrigin = options.publicOrigin ?? settings.publicOrigin;
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.addHook('onClose', async () => { await db.close(); });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      const localOrigin = !settings.production && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin ?? '') && origin === `${req.protocol}://${req.headers.host}`;
      assert(!origin || origin === publicOrigin || localOrigin, 'CSRF_REJECTED', '请从本站页面提交操作', 403);
      assert(req.headers['sec-fetch-site'] !== 'cross-site', 'CSRF_REJECTED', '不允许跨站提交', 403);
      const contentType = req.headers['content-type'];
      assert(!contentType || /^application\/json(?:;|$)/i.test(contentType), 'INVALID_CONTENT_TYPE', '请使用 JSON 请求', 415);
    }
    req.actor = await identity.lookup(req.cookies.bg_session);
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    const e = error as { code?: string; statusCode?: number; message?: string };
    if (e.code === '23505') return reply.code(409).send({ error: { code: 'CONFLICT', message: '数据已改变，请刷新后重试' } });
    if (e.code === '55P03' || e.code === '40P01') return reply.code(409).send({ error: { code: 'BUSY', message: '活动正在更新，请重试' } });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: e.statusCode === 429 ? 'RATE_LIMITED' : 'INVALID_REQUEST', message: e.statusCode === 429 ? '操作过于频繁，请稍后重试' : '请求格式不正确' } });
    req.log.error(error, 'Request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' } });
  });
  const body = (req: FastifyRequest): Row => {
    if (req.body === undefined || req.body === null) return {};
    assert(typeof req.body === 'object' && !Array.isArray(req.body), 'INVALID_INPUT', '请求需要 JSON 对象');
    return req.body as Row;
  };
  const params = (req: FastifyRequest) => req.params as Record<string, string>;
  const actor = (req: FastifyRequest) => {
    assert(req.actor, 'NAME_REQUIRED', '请先填写姓名或微信名', 401);
    return req.actor;
  };
  const ensureIdentity = async (req: FastifyRequest, reply: FastifyReply, fallback?: string) => {
    if (req.actor) return req.actor;
    const created = await identity.create(body(req).displayName ?? fallback);
    reply.setCookie('bg_session', created.token, { path: '/', httpOnly: true, sameSite: 'lax', secure: settings.production, maxAge: settings.sessionDays * 86400 });
    req.actor = created.actor;
    return created.actor;
  };
  const routes: Array<{ method: string; path: string }> = [];
  const route = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string,
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>, limited = false) => {
    routes.push({ method, path });
    app.route({ method, url: `/api/v1${path}`, config: limited ? { rateLimit: { max: 30, timeWindow: '1 minute' } } : {},
      handler: async (req, reply) => path === '/openapi.json' ? handler(req, reply) : ({ data: await handler(req, reply) }) });
  };
  route('GET', '/session', async (req) => ({ participant: await identity.get(req.actor) }));
  route('POST', '/session', async (req, reply) => {
    const existing = req.actor;
    const current = await ensureIdentity(req, reply);
    return { participant: existing ? await identity.rename(current, body(req).displayName) : await identity.get(current) };
  }, true);
  route('POST', '/events', async (req, reply) => app.service.createEvent(await ensureIdentity(req, reply), body(req)), true);
  route('GET', '/events/resolve/:code', async (req) => app.service.resolve(params(req).code!));
  route('GET', '/events/:code', async (req) => app.service.view(params(req).code!, req.actor));
  route('GET', '/events/:code/results', async (req) => app.service.view(params(req).code!, req.actor));
  route('POST', '/events/:code/members', async (req, reply) => app.service.joinEvent(params(req).code!, await ensureIdentity(req, reply), body(req)));
  route('PATCH', '/events/:code', async (req) => app.service.updateEvent(params(req).code!, actor(req), body(req)));
  route('DELETE', '/events/:code', async (req) => app.service.deleteEvent(params(req).code!, actor(req)));
  route('POST', '/events/:code/finalize', async (req) => app.service.finalizeEvent(params(req).code!, actor(req)));
  route('POST', '/events/:code/games', async (req) => app.service.createGame(params(req).code!, actor(req), body(req)));
  route('PATCH', '/events/:code/games/:id', async (req) => app.service.updateGame(params(req).code!, params(req).id!, actor(req), body(req)));
  route('DELETE', '/events/:code/games/:id', async (req) => app.service.deleteGame(params(req).code!, params(req).id!, actor(req)));
  route('POST', '/events/:code/games/:id/registrations', async (req) => app.service.joinGame(params(req).code!, params(req).id!, actor(req)));
  route('PATCH', '/events/:code/my-registration', async (req) => app.service.updateSecondChoice(params(req).code!, actor(req), body(req).secondaryGameId));
  route('DELETE', '/events/:code/my-registration', async (req) => app.service.dropGame(params(req).code!, actor(req)));
  route('POST', '/events/:code/manage', async (req, reply) => app.service.recover(params(req).code!, await ensureIdentity(req, reply, '活动管理员'), body(req).managementKey), true);
  route('POST', '/events/:code/management-key', async (req) => app.service.rotateManagementKey(params(req).code!, actor(req)), true);
  route('PUT', '/events/:code/admins/:id', async (req) => app.service.setAdmin(params(req).code!, actor(req), params(req).id!, body(req).isAdmin));
  route('POST', '/events/:code/owner-transfer', async (req) => app.service.transferOwner(params(req).code!, actor(req), String(body(req).participantId ?? '')));
  route('POST', '/events/:code/preview', async (req) => app.service.preview(params(req).code!, actor(req)));
  route('POST', '/events/:code/test-users', async (req) => app.service.createTestUsers(params(req).code!, actor(req), body(req).count));
  route('POST', '/events/:code/test-games', async (req) => app.service.createTestUsers(params(req).code!, actor(req), 1, { hostGame: body(req) }));
  route('POST', '/events/:code/games/:id/test-users', async (req) => app.service.createTestUsers(params(req).code!, actor(req), body(req).count, { gameId: params(req).id! }));
  route('POST', '/events/:code/test-finalize', async (req) => app.service.finalizeTestEvent(params(req).code!, actor(req)));
  route('POST', '/events/:code/test-fill', async (req) => app.service.fillTestUsers(params(req).code!, actor(req)));
  route('POST', '/events/:code/test-reuse', async (req) => app.service.reuseTestUsers(params(req).code!, actor(req)));
  route('POST', '/events/:code/test-users/:id/join', async (req) => app.service.joinTestUser(params(req).code!, actor(req), params(req).id!, String(body(req).gameId ?? '')));
  route('POST', '/events/:code/test-users/:id/drop', async (req) => app.service.dropTestUser(params(req).code!, actor(req), params(req).id!));
  route('DELETE', '/events/:code/test-users', async (req) => app.service.clearTestUsers(params(req).code!, actor(req)));
  route('DELETE', '/events/:code/test-event', async (req) => app.service.clearTestEvent(params(req).code!, actor(req)));
  route('GET', '/health/live', async () => ({ status: 'ok' }));
  route('GET', '/health/ready', async () => { await db.query('SELECT 1'); return { status: 'ok', database: db.kind }; });
  route('GET', '/openapi.json', async () => buildOpenApi(routes));
  // Only these public assets are exposed; request paths are never filesystem paths.
  const [html, javascript, stylesheet] = await Promise.all(['index.html', 'app.js', 'styles.css'].map((name) => readFile(resolve('public', name), 'utf8')));
  app.get('/', async (_req, reply) => reply.type('text/html').header('Cache-Control', 'no-cache').send(html));
  app.get('/events/:code', async (_req, reply) => reply.type('text/html').header('Cache-Control', 'no-cache').send(html));
  app.get('/app.js', async (_req, reply) => reply.type('application/javascript').header('Cache-Control', 'no-cache').send(javascript));
  app.get('/styles.css', async (_req, reply) => reply.type('text/css').header('Cache-Control', 'no-cache').send(stylesheet));
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: '页面或接口不存在' } }));
  return app;
}
