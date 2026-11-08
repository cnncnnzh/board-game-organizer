import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';

const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = 'http://localhost:3000';
const runId = randomUUID().slice(0, 8);
let now = Date.parse('2027-01-10T18:00:00Z');
let requestNumber = 0;
let app: Awaited<ReturnType<typeof buildApp>>;
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type App = Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  const db = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  app = await buildApp({ db, now: () => now, testTools: true, logger: false, publicOrigin: ORIGIN });
  await app.ready();
});
after(async () => { if (app) await app.close(); });

test('API schema is directly consumable and public files never expose server files', async () => {
  const schemaResponse = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
  const schema = schemaResponse.json();
  assert.equal(schema.openapi, '3.1.0');
  assert.equal(schema.data, undefined);
  assert.ok(schema.paths['/events/{code}/games'].post.requestBody);
  assert.ok(schema.components.schemas.EventView);
  const script = await app.inject({ method: 'GET', url: '/app.js' });
  assert.equal(script.statusCode, 200);
  assert.match(String(script.headers['content-type']), /javascript/);
  for (const path of ['/.env', '/PLAN.md', '/src/config.ts', '/migrations/001_initial.sql', '/data/board-games']) {
    const response = await app.inject({ method: 'GET', url: path });
    assert.equal(response.statusCode, 404, path);
  }
});

async function request(method: Method, path: string, cookie = '', payload?: unknown, target = app, origin = ORIGIN) {
  const response = await target.inject({
    method,
    url: `/api/v1${path}`,
    remoteAddress: `192.0.${Math.floor(requestNumber / 250) % 250}.${++requestNumber % 250 + 1}`,
    headers: { origin, ...(cookie ? { cookie } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });
  const body = response.json();
  const header = response.headers['set-cookie'];
  const cookies = (Array.isArray(header) ? header : [header ?? '']).join(';');
  return { status: response.statusCode, data: body.data as any, error: body.error as any, cookie: cookies.match(/(?:^|[;\s])bg_session=([^;]+)/)?.[0]?.trim().replace(/^;\s*/, '') ?? '', response };
}
function success(result: Awaited<ReturnType<typeof request>>) {
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify({ status: result.status, error: result.error }));
  return result.data;
}
function eventPayload(name = '组织者') {
  return {
    displayName: `${name}-${runId}`,
    title: `集成测试-${runId}`,
    location: 'Chicago table room',
    startAt: new Date(now + 2 * DAY).toISOString(),
    endAt: new Date(now + 2 * DAY + 4 * 3600000).toISOString(),
    timeZone: 'America/Chicago',
  };
}
async function createEvent(target: App = app, existingCookie = '', name = '组织者') {
  const created = await request('POST', '/events', existingCookie, eventPayload(name), target);
  const data = success(created);
  assert.match(data.event.code, /^[A-Z0-9]{6,8}$/);
  assert.ok(data.managementKey?.length >= 20, 'creation returns an unguessable recovery key');
  const cookie = created.cookie || existingCookie;
  assert.ok(cookie, 'anonymous cookie created automatically');
  return { code: data.event.code as string, event: data.event, key: data.managementKey as string, cookie, data };
}
async function participant(code: string, name: string, target: App = app) {
  const session = await request('POST', '/session', '', { displayName: name }, target);
  const data = success(session);
  assert.ok(session.cookie);
  success(await request('POST', `/events/${code}/members`, session.cookie, { displayName: name }, target));
  return { cookie: session.cookie, id: data.participant.id as string, name };
}
async function game(code: string, cookie: string, capacity: number, name = '卡坦岛') {
  const result = await request('POST', `/events/${code}/games`, cookie, { name, capacity, description: '带上桌游', difficulty: '入门' });
  const data = success(result);
  return (data.game?.id ?? data.gameId ?? data.id) as string;
}
async function snapshot(code: string, cookie = '') { return success(await request('GET', `/events/${code}`, cookie)); }
async function join(code: string, gameId: string, cookie: string) { return request('POST', `/events/${code}/games/${gameId}/registrations`, cookie, {}); }

test('home is public, event creation is anonymous, and codes resolve without exposing organizer secrets', async () => {
  const home = await app.inject({ method: 'GET', url: '/' });
  assert.equal(home.statusCode, 200);
  assert.match(home.headers['content-type'] ?? '', /html/);
  assert.equal(success(await request('GET', '/session')).participant, null);
  const created = await createEvent();
  const session = success(await request('GET', '/session', created.cookie));
  assert.ok(session.participant.id);
  const view = await snapshot(created.code);
  assert.equal(view.event.code, created.code);
  assert.equal(view.event.canManage, false);
  assert.equal(view.event.role, 'guest');
  assert.ok(!JSON.stringify(view).includes(created.key));
  assert.ok(!JSON.stringify(view).includes('password'));
  const resolved = success(await request('GET', `/events/resolve/${created.code.toLowerCase()}`));
  assert.equal(resolved.code, created.code);
});

test('different organizers can create independent events from the home page', async () => {
  const one = await createEvent();
  const two = await createEvent();
  assert.notEqual(one.code, two.code);
  assert.equal((await snapshot(one.code, one.cookie)).event.role, 'owner');
  assert.equal((await snapshot(two.code, two.cookie)).event.role, 'owner');
  assert.equal((await snapshot(two.code, one.cookie)).event.canManage, false);
});

test('display names do not grant identity or let another browser take over an existing event member', async () => {
  const created = await createEvent();
  const first = await participant(created.code, '小王');
  const imposter = await request('POST', '/session', '', { displayName: '小王' });
  success(imposter);
  const attach = await request('POST', `/events/${created.code}/members`, imposter.cookie, { displayName: '小王' });
  assert.equal(attach.status, 409);
  assert.equal(attach.error.code, 'NAME_TAKEN');
  const gameId = await game(created.code, first.cookie, 2);
  const changed = await request('PATCH', `/events/${created.code}/games/${gameId}`, imposter.cookie, { name: '冒名', capacity: 2 });
  assert.ok(changed.status === 401 || changed.status === 403);
  assert.equal((await snapshot(created.code, first.cookie)).games[0].hostId, first.id);
});

test('simultaneous attempts for the last seat produce exactly one attendee and one waiting member', async () => {
  const created = await createEvent();
  const gameId = await game(created.code, created.cookie, 2);
  const a = await participant(created.code, '抢位甲');
  const b = await participant(created.code, '抢位乙');
  const results = await Promise.all([join(created.code, gameId, a.cookie), join(created.code, gameId, b.cookie)]);
  results.forEach(success);
  const view = await snapshot(created.code);
  assert.equal(view.games[0].attendees.length, 2);
  assert.equal(view.games[0].waitlist.length, 1);
  const states = await Promise.all([snapshot(created.code, a.cookie), snapshot(created.code, b.cookie)]);
  assert.deepEqual(states.map((s) => s.registration.status).sort(), ['attendee', 'waitlist']);
});

test('simultaneous cross-table registrations keep a single primary choice', async () => {
  const created = await createEvent();
  const host = await participant(created.code, '另桌Host');
  const one = await game(created.code, created.cookie, 4, '桌一');
  const two = await game(created.code, host.cookie, 4, '桌二');
  const candidate = await participant(created.code, '只选一桌');
  const results = await Promise.all([join(created.code, one, candidate.cookie), join(created.code, two, candidate.cookie)]);
  assert.equal(results.filter((r) => r.status >= 200 && r.status < 300).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 1);
  const view = await snapshot(created.code, candidate.cookie);
  assert.ok([one, two].includes(view.registration.primaryGameId));
  const entries = view.games.flatMap((g: any) => [...g.attendees, ...g.waitlist]).filter((p: any) => p.participantId === candidate.id);
  assert.equal(entries.length, 1);
});

test('dropping an attendee promotes waiting members FIFO, including equal-time arrivals', async () => {
  const created = await createEvent();
  const gameId = await game(created.code, created.cookie, 2);
  const a = await participant(created.code, '入席者');
  const b = await participant(created.code, '候补一');
  const c = await participant(created.code, '候补二');
  success(await join(created.code, gameId, a.cookie));
  success(await join(created.code, gameId, b.cookie));
  success(await join(created.code, gameId, c.cookie));
  const before = await snapshot(created.code);
  assert.deepEqual(before.games[0].waitlist.map((p: any) => p.participantId), [b.id, c.id]);
  success(await request('DELETE', `/events/${created.code}/my-registration`, a.cookie));
  assert.equal((await snapshot(created.code, b.cookie)).registration.status, 'attendee');
  assert.equal((await snapshot(created.code, c.cookie)).registration.status, 'waitlist');
  success(await request('DELETE', `/events/${created.code}/my-registration`, b.cookie));
  assert.equal((await snapshot(created.code, c.cookie)).registration.status, 'attendee');
});

test('increasing capacity promotes candidates and shrinking below occupancy fails', async () => {
  const created = await createEvent();
  const gameId = await game(created.code, created.cookie, 1);
  const a = await participant(created.code, '扩容一');
  const b = await participant(created.code, '扩容二');
  success(await join(created.code, gameId, a.cookie));
  success(await join(created.code, gameId, b.cookie));
  success(await request('PATCH', `/events/${created.code}/games/${gameId}`, created.cookie, { name: '卡坦岛', capacity: 3 }));
  const view = await snapshot(created.code);
  assert.equal(view.games[0].attendees.length, 3);
  assert.equal(view.games[0].waitlist.length, 0);
  const shrink = await request('PATCH', `/events/${created.code}/games/${gameId}`, created.cookie, { name: '卡坦岛', capacity: 2 });
  assert.equal(shrink.status, 400);
  assert.equal((await snapshot(created.code)).games[0].capacity, 3);
});

test('host cannot drop normally; only host can edit/delete and deleting a table releases all registrations', async () => {
  const created = await createEvent();
  const host = await participant(created.code, '桌主');
  const attendee = await participant(created.code, '玩家');
  const waiting = await participant(created.code, '候补');
  const gameId = await game(created.code, host.cookie, 2);
  success(await join(created.code, gameId, attendee.cookie));
  success(await join(created.code, gameId, waiting.cookie));
  const drop = await request('DELETE', `/events/${created.code}/my-registration`, host.cookie);
  assert.ok(drop.status >= 400);
  assert.equal(drop.error.code, 'HOST_MUST_DELETE');
  assert.equal((await request('DELETE', `/events/${created.code}/games/${gameId}`, created.cookie)).status, 403);
  assert.equal((await request('PATCH', `/events/${created.code}/games/${gameId}`, attendee.cookie, { name: '非法修改', capacity: 3 })).status, 403);
  success(await request('DELETE', `/events/${created.code}/games/${gameId}`, host.cookie));
  for (const person of [host, attendee, waiting]) assert.equal((await snapshot(created.code, person.cookie)).registration, null);
});

test('organizer permissions are event-scoped and administrator cannot appoint administrators', async () => {
  const created = await createEvent();
  const admin = await participant(created.code, '活动管理员');
  const other = await participant(created.code, '普通成员');
  assert.equal((await request('PUT', `/events/${created.code}/admins/${admin.id}`, other.cookie, { isAdmin: true })).status, 403);
  success(await request('PUT', `/events/${created.code}/admins/${admin.id}`, created.cookie, { isAdmin: true }));
  assert.equal((await snapshot(created.code, admin.cookie)).event.role, 'admin');
  assert.equal((await request('PUT', `/events/${created.code}/admins/${other.id}`, admin.cookie, { isAdmin: true })).status, 403);
  success(await request('PATCH', `/events/${created.code}`, admin.cookie, { ...eventPayload(), title: '管理员更正' }));
  assert.equal((await snapshot(created.code)).event.title, '管理员更正');
  success(await request('PUT', `/events/${created.code}/admins/${admin.id}`, created.cookie, { isAdmin: false }));
  assert.equal((await snapshot(created.code, admin.cookie)).event.canManage, false);
});

test('owner transfer is atomic, rotates recovery key, and demotes the previous owner to admin', async () => {
  const created = await createEvent();
  const next = await participant(created.code, '新组织者');
  const oldRecovery = await request('POST', `/events/${created.code}/manage`, '', { managementKey: created.key, displayName: '旧组织者恢复' });
  success(oldRecovery);
  assert.equal((await snapshot(created.code, oldRecovery.cookie)).event.role, 'owner');
  const transfer = success(await request('POST', `/events/${created.code}/owner-transfer`, created.cookie, { participantId: next.id }));
  assert.equal(transfer.managementKey, undefined, 'previous owner must never receive the new owner recovery credential');
  assert.equal(transfer.ownerId, next.id);
  assert.equal((await snapshot(created.code, next.cookie)).event.role, 'owner');
  assert.equal((await snapshot(created.code, created.cookie)).event.role, 'admin');
  assert.equal((await snapshot(created.code, oldRecovery.cookie)).event.canManage, false, 'transfer revokes old recovered-session grants');
  const staleKey = await request('POST', `/events/${created.code}/manage`, '', { managementKey: created.key });
  assert.equal(staleKey.status, 403);
  assert.equal((await request('POST', `/events/${created.code}/management-key`, created.cookie, {})).status, 403);
  const key = success(await request('POST', `/events/${created.code}/management-key`, next.cookie, {}));
  assert.ok(key.managementKey && key.managementKey !== created.key);
  const recovered = await request('POST', `/events/${created.code}/manage`, '', { managementKey: key.managementKey, displayName: '恢复组织者' });
  success(recovered);
  assert.ok(recovered.cookie);
  assert.equal((await snapshot(created.code, recovered.cookie)).event.role, 'owner');
});

test('a recovery key for event A cannot confer authority over event B created in the same original browser', async () => {
  const one = await createEvent();
  const two = await createEvent(app, one.cookie);
  assert.equal((await snapshot(two.code, one.cookie)).event.role, 'owner');
  const recovered = await request('POST', `/events/${one.code}/manage`, '', { managementKey: one.key, displayName: '恢复管理' });
  success(recovered);
  assert.equal((await snapshot(one.code, recovered.cookie)).event.role, 'owner');
  assert.equal((await snapshot(two.code, recovered.cookie)).event.canManage, false);
  const forbidden = await request('PATCH', `/events/${two.code}`, recovered.cookie, { ...eventPayload(), title: '越权修改' });
  assert.ok(forbidden.status === 401 || forbidden.status === 403);
});

test('cross-origin writes are rejected while ordinary public event reads remain available', async () => {
  const created = await createEvent();
  const csrf = await request('PATCH', `/events/${created.code}`, created.cookie, { ...eventPayload(), title: '跨站' }, app, 'https://attacker.example');
  assert.equal(csrf.status, 403);
  assert.equal((await snapshot(created.code)).event.title, created.event.title);
  const noCookie = await request('POST', `/events/${created.code}/games`, '', { name: '没有凭证', capacity: 4, participantId: created.data.participant?.id });
  assert.ok(noCookie.status === 401 || noCookie.status === 403);
  assert.equal((await request('GET', `/events/${created.code}`, '', undefined, app, 'https://elsewhere.example')).status, 200);
});

test('at the exact deadline writes stop and reading results finalizes the event once', async () => {
  const created = await createEvent();
  const gameId = await game(created.code, created.cookie, 2);
  const candidate = await participant(created.code, '截止玩家');
  now = Date.parse(created.event.registrationClosesAt);
  const late = await join(created.code, gameId, candidate.cookie);
  assert.ok(late.status >= 400);
  assert.equal(late.error.code, 'EVENT_CLOSED');
  const views = await Promise.all([snapshot(created.code), snapshot(created.code)]);
  views.forEach((view) => assert.equal(view.event.status, 'finalized'));
  assert.equal(views[0].games[0].attendees.length, 1);
  const edit = await request('PATCH', `/events/${created.code}/games/${gameId}`, created.cookie, { name: '已截止', capacity: 3 });
  assert.equal(edit.error.code, 'EVENT_CLOSED');
  assert.ok((await request('DELETE', `/events/${created.code}`, created.cookie)).status >= 400);
});

test('a registration waiting behind another transaction cannot slip past the deadline', async () => {
  const created = await createEvent();
  const gameId = await game(created.code, created.cookie, 2);
  const candidate = await participant(created.code, '锁等待玩家');
  let signalAcquired!: () => void;
  let releaseLock!: () => void;
  const acquired = new Promise<void>((resolve) => { signalAcquired = resolve; });
  const gate = new Promise<void>((resolve) => { releaseLock = resolve; });
  const blocker = app.db.transaction(async (tx) => {
    await tx.query('SELECT id FROM events WHERE code=$1 FOR UPDATE', [created.code]);
    signalAcquired();
    await gate;
  });
  await acquired;
  const pendingRegistration = join(created.code, gameId, candidate.cookie);
  await new Promise<void>((resolve) => setImmediate(resolve));
  now = Date.parse(created.event.registrationClosesAt);
  releaseLock();
  await blocker;
  const rejected = await pendingRegistration;
  assert.equal(rejected.error.code, 'EVENT_CLOSED');
  assert.equal((await snapshot(created.code, candidate.cookie)).registration, null);
});

test('participant IDs and malformed session cookies cannot be used as anonymous session credentials', async () => {
  const created = await createEvent();
  const person = await participant(created.code, '凭证校验');
  const fakeCookie = `bg_session=${person.id}`;
  assert.equal(success(await request('GET', '/session', fakeCookie)).participant, null);
  const forged = await request('POST', `/events/${created.code}/games`, fakeCookie, { name: '伪造身份', capacity: 4, participantId: person.id, role: 'owner' });
  assert.ok(forged.status === 401 || forged.status === 403);
  assert.equal((await snapshot(created.code)).games.length, 0);
});

test('preview is read-only and matches deterministic finalization of the same snapshot', async () => {
  const created = await createEvent();
  const secondHost = await participant(created.code, '空桌Host');
  const full = await game(created.code, created.cookie, 1, '满员桌');
  await game(created.code, secondHost.cookie, 3, '空位桌');
  for (let i = 0; i < 3; i++) {
    const member = await participant(created.code, `预览候补${i}`);
    success(await join(created.code, full, member.cookie));
  }
  const first = success(await request('POST', `/events/${created.code}/preview`, created.cookie, {}));
  const second = success(await request('POST', `/events/${created.code}/preview`, created.cookie, {}));
  assert.deepEqual(first, second);
  const before = await snapshot(created.code);
  assert.equal(before.event.status, 'open');
  assert.equal(before.games[0].waitlist.length, 3);
  now = Date.parse(created.event.registrationClosesAt) + 1;
  const finalized = success(await request('GET', `/events/${created.code}/results`));
  assert.equal(finalized.event.status, 'finalized');
  assert.deepEqual(finalized.event.result, first.result);
  const assignments = (view: any) => view.games.map((g: any) => ({ id: g.id, attendees: g.attendees.map((p: any) => p.participantId).sort() })).sort((a: any, b: any) => a.id.localeCompare(b.id));
  assert.deepEqual(assignments(finalized), assignments(first));
  assert.equal(finalized.unassigned.length, 1);
  assert.equal(finalized.games.reduce((sum: number, g: any) => sum + g.waitlist.length, 0), 0);
  const settledAgain = await snapshot(created.code);
  assert.deepEqual(assignments(settledAgain), assignments(finalized));
});

test('finalized metadata corrections keep the results frozen, and housekeeping deletes only expired events', async () => {
  const created = await createEvent();
  await game(created.code, created.cookie, 2);
  now = Date.parse(created.event.registrationClosesAt) + 1;
  const before = await snapshot(created.code);
  success(await request('PATCH', `/events/${created.code}`, created.cookie, { ...eventPayload(), title: '展示时间更正', startAt: new Date(now + 3600000).toISOString(), endAt: new Date(now + 5 * 3600000).toISOString() }));
  const after = await snapshot(created.code);
  assert.equal(after.event.status, 'finalized');
  assert.deepEqual(after.event.result, before.event.result);
  const younger = await createEvent();
  now = Date.parse(after.event.endAt) + DAY - 1;
  await app.service.runHousekeeping();
  assert.equal((await request('GET', `/events/${created.code}`)).status, 200);
  now += 1;
  await app.service.runHousekeeping();
  assert.equal((await request('GET', `/events/${created.code}`)).status, 404);
  assert.equal((await request('GET', `/events/${younger.code}`)).status, 200);
});

test('test tools simulate users and hosted games, preserve real accounts, and are owner-only', async () => {
  const created = await createEvent();
  const real = await participant(created.code, '真实用户');
  const primary = await game(created.code, created.cookie, 2);
  assert.equal((await request('POST', `/events/${created.code}/test-users`, real.cookie, { count: 3 })).status, 403);
  success(await request('POST', `/events/${created.code}/test-users`, created.cookie, { count: 3 }));
  success(await request('POST', `/events/${created.code}/test-games`, created.cookie, { name: '测试桌', capacity: 2 }));
  const hosted = (await snapshot(created.code)).games.find((g: any) => g.id !== primary);
  success(await join(created.code, hosted.id, real.cookie));
  success(await request('POST', `/events/${created.code}/test-fill`, created.cookie, {}));
  const view = await snapshot(created.code);
  const testMembers = view.members.filter((m: any) => m.isTest);
  assert.equal(testMembers.length, 4);
  const testPerson = testMembers.find((m: any) => m.id !== hosted.hostId);
  const forbiddenAdmin = await request('PUT', `/events/${created.code}/admins/${testPerson.id}`, created.cookie, { isAdmin: true });
  assert.ok(forbiddenAdmin.status >= 400);
  success(await request('POST', `/events/${created.code}/test-users/${testPerson.id}/drop`, created.cookie, {}));
  success(await request('POST', `/events/${created.code}/test-users/${testPerson.id}/join`, created.cookie, { gameId: primary }));
  success(await request('DELETE', `/events/${created.code}/test-users`, created.cookie));
  const cleared = await snapshot(created.code, real.cookie);
  assert.equal(cleared.members.filter((m: any) => m.isTest).length, 0);
  assert.equal(cleared.games.length, 1);
  assert.equal(cleared.registration, null, 'deleting test-host table releases real attendee registration');
  assert.ok(cleared.members.some((m: any) => m.id === real.id), 'real event membership is preserved');
  assert.ok(success(await request('GET', '/session', real.cookie)).participant);
});

test('test tools are rejected server-side when disabled', async () => {
  const isolated = await buildApp({ db: await openDatabase({ url: process.env.TEST_DATABASE_URL }), now: () => now, testTools: false, logger: false, publicOrigin: ORIGIN });
  try {
    await isolated.ready();
    const created = await createEvent(isolated);
    const view = await snapshotFor(isolated, created.code, created.cookie);
    assert.equal(view.testToolsEnabled, false);
    const attempt = await request('POST', `/events/${created.code}/test-users`, created.cookie, { count: 2 }, isolated);
    assert.ok(attempt.status === 403 || attempt.status === 404);
  } finally { await isolated.close(); }
});
async function snapshotFor(target: App, code: string, cookie: string) { return success(await request('GET', `/events/${code}`, cookie, undefined, target)); }

test('cleared test events retain a reusable test-user pool scoped to the same organizer', async () => {
  const created = await createEvent();
  success(await request('POST', `/events/${created.code}/test-users`, created.cookie, { count: 3 }));
  const originalIds = (await snapshot(created.code)).members.filter((m: any) => m.isTest).map((m: any) => m.id).sort();
  success(await request('DELETE', `/events/${created.code}/test-event`, created.cookie));
  assert.equal((await request('GET', `/events/${created.code}`)).status, 404);
  const outsider = await createEvent();
  const outsiderReuse = success(await request('POST', `/events/${outsider.code}/test-reuse`, outsider.cookie, {}));
  assert.equal(outsiderReuse.reusedCount, 0);
  const next = await createEvent(app, created.cookie);
  const reuse = success(await request('POST', `/events/${next.code}/test-reuse`, next.cookie, {}));
  assert.equal(reuse.reusedCount, 3);
  const reusedIds = (await snapshot(next.code)).members.filter((m: any) => m.isTest).map((m: any) => m.id).sort();
  assert.deepEqual(reusedIds, originalIds);
  const secondReuse = success(await request('POST', `/events/${next.code}/test-reuse`, next.cookie, {}));
  assert.equal(secondReuse.reusedCount, 0, 'already-attached users cannot be claimed twice');
});

test('settlement processes more than 100 registrations without silently truncating candidates', async () => {
  const created = await createEvent();
  const secondHost = await participant(created.code, '大桌Host');
  const full = await game(created.code, created.cookie, 1, '主选已满');
  await game(created.code, secondHost.cookie, 100, '大桌');
  for (let i = 0; i < 101; i++) {
    const member = await participant(created.code, `大量报名${i}`);
    success(await join(created.code, full, member.cookie));
  }
  const before = await snapshot(created.code);
  assert.equal(before.games[0].waitlist.length, 101);
  now = Date.parse(created.event.registrationClosesAt) + 1;
  const result = await snapshot(created.code);
  assert.equal(result.event.result.assignedFromWaitlist, 99);
  assert.equal(result.event.result.unassignedCount, 2);
  assert.equal(result.unassigned.length, 2);
  assert.equal(result.games.reduce((n: number, g: any) => n + g.attendees.length, 0), 101);
});

test('deleting an open event cascades its games and registrations without touching another event', async () => {
  const created = await createEvent();
  const keeper = await createEvent();
  const person = await participant(created.code, '待释放玩家');
  const gameId = await game(created.code, created.cookie, 2);
  success(await join(created.code, gameId, person.cookie));
  success(await request('DELETE', `/events/${created.code}`, created.cookie));
  assert.equal((await request('GET', `/events/${created.code}`)).status, 404);
  assert.equal((await request('GET', `/events/${keeper.code}`)).status, 200);
});
