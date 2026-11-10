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
  assert.ok(schema.paths['/events/{code}/games/{id}/test-users'].post.requestBody);
  const secondChoiceSchema = schema.paths['/events/{code}/my-registration'].patch;
  assert.deepEqual(secondChoiceSchema.requestBody.content['application/json'].schema.required, ['secondaryGameId']);
  assert.ok(schema.components.schemas.MyRegistration);
  assert.equal(schema.components.schemas.Registration.properties.secondaryGameId, undefined);
  assert.ok(schema.paths['/events/{code}/test-finalize'].post.responses['200']);
  const finalize = schema.paths['/events/{code}/finalize'].post;
  assert.equal(finalize.responses['200'].content['application/json'].schema.properties.data.properties.result.$ref, '#/components/schemas/Result');
  assert.deepEqual(finalize.tags, ['events']);
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
async function secondChoice(code: string, cookie: string, secondaryGameId: string | null) {
  return request('PATCH', `/events/${code}/my-registration`, cookie, { secondaryGameId });
}

test('waitlisted players can save, change and cancel private second choices including full tables without changing counts', async () => {
  const created = await createEvent();
  const primary = await game(created.code, created.cookie, 1, '第一选择');
  const fullHost = await participant(created.code, '第二选择满桌Host');
  const openHost = await participant(created.code, '第二选择空桌Host');
  const full = await game(created.code, fullHost.cookie, 1, '可选满桌');
  const open = await game(created.code, openHost.cookie, 4, '可选空桌');
  const player = await participant(created.code, '第二选择玩家');
  success(await join(created.code, primary, player.cookie));
  const before = await snapshot(created.code);
  assert.equal((await snapshot(created.code, player.cookie)).registration.secondaryGameId, null);
  assert.deepEqual(success(await secondChoice(created.code, player.cookie, full)), { secondaryGameId: full });
  let mine = await snapshot(created.code, player.cookie);
  assert.equal(mine.registration.secondaryGameId, full);
  assert.equal(mine.registration.primaryGameId, primary);
  assert.equal(mine.registration.status, 'waitlist');
  assert.deepEqual(mine.games, before.games);
  for (const cookie of ['', created.cookie, fullHost.cookie, openHost.cookie, player.cookie]) {
    const view = await snapshot(created.code, cookie);
    assert.ok(!JSON.stringify({ games: view.games, members: view.members, unassigned: view.unassigned }).includes('secondaryGameId'));
    if (cookie !== player.cookie && view.registration) assert.equal(view.registration.secondaryGameId, null);
  }
  success(await secondChoice(created.code, player.cookie, open));
  mine = await snapshot(created.code, player.cookie);
  assert.equal(mine.registration.secondaryGameId, open);
  assert.equal(mine.registration.status, 'waitlist', 'an open second-choice table does not immediately seat the player');
  assert.deepEqual(mine.games, before.games);
  success(await secondChoice(created.code, player.cookie, null));
  assert.equal((await snapshot(created.code, player.cookie)).registration.secondaryGameId, null);
  assert.deepEqual((await snapshot(created.code)).games, before.games);
});

test('second-choice writes validate waitlist status, event scope and inputs and cannot target another player', async () => {
  const created = await createEvent();
  const primary = await game(created.code, created.cookie, 1);
  const host = await participant(created.code, '校验第二桌Host');
  const secondary = await game(created.code, host.cookie, 2);
  const seated = await participant(created.code, '已入席不能第二选择');
  success(await join(created.code, secondary, seated.cookie));
  const player = await participant(created.code, '校验候补');
  success(await join(created.code, primary, player.cookie));
  const unregistered = await participant(created.code, '未报名不能第二选择');
  const other = await createEvent();
  const foreign = await game(other.code, other.cookie, 2);
  const path = `/events/${created.code}/my-registration`;
  assert.equal((await request('PATCH', path, '', { secondaryGameId: secondary })).status, 401);
  assert.equal((await secondChoice(created.code, other.cookie, secondary)).status, 401);
  assert.equal((await secondChoice(created.code, unregistered.cookie, secondary)).status, 404);
  for (const cookie of [created.cookie, seated.cookie]) {
    assert.equal((await secondChoice(created.code, cookie, secondary)).error.code, 'NOT_WAITLISTED');
  }
  for (const payload of [{}, { secondaryGameId: '' }, { secondaryGameId: ' ' }, { secondaryGameId: true }, { secondaryGameId: {} }, { secondaryGameId: primary }]) {
    assert.equal((await request('PATCH', path, player.cookie, payload)).error.code, 'INVALID_INPUT');
  }
  for (const id of [foreign, randomUUID()]) assert.equal((await secondChoice(created.code, player.cookie, id)).status, 404);
  success(await request('PATCH', path, player.cookie, { secondaryGameId: secondary, participantId: seated.id }));
  assert.equal((await snapshot(created.code, player.cookie)).registration.secondaryGameId, secondary);
  assert.equal((await snapshot(created.code, seated.cookie)).registration.secondaryGameId, null);
  await assert.rejects(app.db.query('UPDATE registrations SET secondary_game_id=$1 WHERE event_id=$2 AND participant_id=$3',
    [foreign, created.event.id, player.id]), (error: any) => error.code === '23503');
  await assert.rejects(app.db.query('UPDATE registrations SET secondary_game_id=primary_game_id WHERE event_id=$1 AND participant_id=$2',
    [created.event.id, player.id]), (error: any) => error.code === '23514');
});

test('FIFO promotion and capacity increases clear second choices, and dropped players rejoin without an old choice', async () => {
  const created = await createEvent();
  const primary = await game(created.code, created.cookie, 2);
  const host = await participant(created.code, '清除第二选择Host');
  const secondary = await game(created.code, host.cookie, 4);
  const seated = await participant(created.code, '清除第二选择入席');
  const first = await participant(created.code, '清除第二选择候补一');
  const next = await participant(created.code, '清除第二选择候补二');
  for (const player of [seated, first, next]) success(await join(created.code, primary, player.cookie));
  for (const player of [first, next]) success(await secondChoice(created.code, player.cookie, secondary));
  success(await request('DELETE', `/events/${created.code}/my-registration`, seated.cookie));
  const promoted = (await snapshot(created.code, first.cookie)).registration;
  assert.equal(promoted.status, 'attendee');
  assert.equal(promoted.secondaryGameId, null);
  assert.equal((await snapshot(created.code, next.cookie)).registration.secondaryGameId, secondary);
  success(await request('PATCH', `/events/${created.code}/games/${primary}`, created.cookie, { capacity: 3 }));
  assert.equal((await snapshot(created.code, next.cookie)).registration.status, 'attendee');
  assert.equal((await snapshot(created.code, next.cookie)).registration.secondaryGameId, null);
  const dropped = await participant(created.code, '退出清除第二选择');
  success(await join(created.code, primary, dropped.cookie));
  success(await secondChoice(created.code, dropped.cookie, secondary));
  success(await request('DELETE', `/events/${created.code}/my-registration`, dropped.cookie));
  success(await join(created.code, primary, dropped.cookie));
  assert.equal((await snapshot(created.code, dropped.cookie)).registration.secondaryGameId, null);
});

test('deleting a second-choice table only clears the preference while deleting the primary releases the registration', async () => {
  const created = await createEvent();
  const primary = await game(created.code, created.cookie, 1);
  const host = await participant(created.code, '删除第二桌Host');
  const secondary = await game(created.code, host.cookie, 2);
  const player = await participant(created.code, '删除第二桌候补');
  success(await join(created.code, primary, player.cookie));
  success(await secondChoice(created.code, player.cookie, secondary));
  success(await request('DELETE', `/events/${created.code}/games/${secondary}`, host.cookie));
  const view = await snapshot(created.code, player.cookie);
  assert.equal(view.registration.primaryGameId, primary);
  assert.equal(view.registration.status, 'waitlist');
  assert.equal(view.registration.secondaryGameId, null);
  assert.equal(view.games[0].waitlist[0].participantId, player.id);
  const replacement = await game(created.code, host.cookie, 2);
  success(await secondChoice(created.code, player.cookie, replacement));
  success(await request('DELETE', `/events/${created.code}/games/${primary}`, created.cookie));
  assert.equal((await snapshot(created.code, player.cookie)).registration, null);
  assert.equal((await snapshot(created.code)).games[0].attendees.length, 1);
});

test('second-choice lotteries precede balancing in preview, natural closure, early closure and test closure with frozen results', async () => {
  for (const mode of ['natural', 'early', 'test']) {
    const created = await createEvent();
    const primary = await game(created.code, created.cookie, 1, '主选满桌');
    const preferredHost = await participant(created.code, '优先桌Host');
    const fallbackHost = await participant(created.code, '均衡桌Host');
    const fullHost = await participant(created.code, '满员第二选择Host');
    const preferred = await game(created.code, preferredHost.cookie, 3, '第二选择优先桌');
    const fallback = await game(created.code, fallbackHost.cookie, 4, '剩余候补均衡桌');
    const fullSecond = await game(created.code, fullHost.cookie, 1, '已满员第二选择');
    const seated = await participant(created.code, '优先桌原成员');
    success(await join(created.code, preferred, seated.cookie));
    const interested = [];
    for (let i = 0; i < 3; i++) {
      const player = await participant(created.code, `第二选择竞争${i}`);
      success(await join(created.code, primary, player.cookie));
      success(await secondChoice(created.code, player.cookie, preferred));
      interested.push(player);
    }
    for (const name of ['没选第二选择', '第二选择满员']) {
      const player = await participant(created.code, name);
      success(await join(created.code, primary, player.cookie));
      if (name === '第二选择满员') success(await secondChoice(created.code, player.cookie, fullSecond));
    }
    const preview = success(await request('POST', `/events/${created.code}/preview`, created.cookie, {}));
    assert.deepEqual(success(await request('POST', `/events/${created.code}/preview`, created.cookie, {})), preview);
    const before = await snapshot(created.code, interested[0]!.cookie);
    assert.equal(before.registration.secondaryGameId, preferred);
    assert.equal(before.registration.status, 'waitlist');
    assert.equal(before.event.status, 'open');
    const preferredResult = preview.games.find((g: any) => g.id === preferred);
    assert.equal(preferredResult.attendees.length, 3);
    assert.equal(preferredResult.attendees.filter((p: any) => interested.some((candidate) => candidate.id === p.participantId)).length, 1);
    if (mode === 'natural') now = Date.parse(created.event.registrationClosesAt);
    else success(await request('POST', `/events/${created.code}/${mode === 'early' ? 'finalize' : 'test-finalize'}`, created.cookie, {}));
    const finalized = await snapshot(created.code);
    const assignments = (view: any) => view.games.map((g: any) => ({ id: g.id, players: g.attendees.map((p: any) => p.participantId).sort() }));
    assert.deepEqual(assignments(finalized), assignments(preview));
    assert.deepEqual(finalized.event.result, preview.result);
    assert.equal(finalized.event.result.assignedFromWaitlist, 4);
    assert.equal(finalized.event.result.unassignedCount, 1);
    assert.equal(finalized.games.find((g: any) => g.id === fallback).attendees.length, 4);
    for (const id of [preferred, null]) assert.equal((await secondChoice(created.code, interested[0]!.cookie, id)).error.code, 'EVENT_CLOSED');
    success(await request('POST', `/events/${created.code}/finalize`, created.cookie, {}));
    assert.deepEqual(assignments(await snapshot(created.code)), assignments(finalized));
  }
});

test('a second-choice update racing closure is either included atomically or rejected', async () => {
  const created = await createEvent();
  const primary = await game(created.code, created.cookie, 1);
  const preferredHost = await participant(created.code, '并发第二选择Host');
  const fallbackHost = await participant(created.code, '并发均衡Host');
  const preferred = await game(created.code, preferredHost.cookie, 4);
  const fallback = await game(created.code, fallbackHost.cookie, 2);
  const seated = await participant(created.code, '并发原入席');
  success(await join(created.code, preferred, seated.cookie));
  const player = await participant(created.code, '并发第二选择玩家');
  success(await join(created.code, primary, player.cookie));
  const [updated, closed] = await Promise.all([
    secondChoice(created.code, player.cookie, preferred),
    request('POST', `/events/${created.code}/finalize`, created.cookie, {}),
  ]);
  success(closed);
  const view = await snapshot(created.code, player.cookie);
  assert.equal(view.registration.finalGameId, updated.status === 200 ? preferred : fallback);
  if (updated.status !== 200) assert.equal(updated.error.code, 'EVENT_CLOSED');
});

test('a second-choice update waiting for the event lock rechecks the exact deadline', async () => {
  const created = await createEvent();
  const primary = await game(created.code, created.cookie, 1);
  const host = await participant(created.code, '第二选择截止Host');
  const secondary = await game(created.code, host.cookie, 2);
  const player = await participant(created.code, '第二选择截止候补');
  success(await join(created.code, primary, player.cookie));
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
  const pending = secondChoice(created.code, player.cookie, secondary);
  await new Promise<void>((resolve) => setImmediate(resolve));
  now = Date.parse(created.event.registrationClosesAt);
  releaseLock();
  await blocker;
  assert.equal((await pending).error.code, 'EVENT_CLOSED');
  assert.equal((await snapshot(created.code, player.cookie)).registration.secondaryGameId, null);
});

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

test('owner can close early with the scheduled allocation rules, frozen results and idempotent concurrent requests', async () => {
  const created = await createEvent();
  const full = await game(created.code, created.cookie, 2, '主选桌');
  const seated = await participant(created.code, '提前截止已入席');
  success(await join(created.code, full, seated.cookie));
  const secondHost = await participant(created.code, '提前截止空桌Host');
  const receiving = await game(created.code, secondHost.cookie, 3, '接收候补桌');
  for (let i = 0; i < 4; i++) {
    const waiting = await participant(created.code, `提前截止候补${i}`);
    success(await join(created.code, full, waiting.cookie));
  }
  const other = await createEvent();
  const before = await snapshot(created.code);
  const seed = (await app.db.query('SELECT seed FROM events WHERE code=$1', [created.code])).rows[0]!.seed;
  const preview = success(await request('POST', `/events/${created.code}/preview`, created.cookie, {}));
  assert.ok(now < Date.parse(created.event.registrationClosesAt));
  const closedAt = now;
  const responses = await Promise.all([
    request('POST', `/events/${created.code}/finalize`, created.cookie, {}),
    request('POST', `/events/${created.code}/finalize`, created.cookie),
  ]);
  responses.forEach((response) => assert.deepEqual(success(response).result, preview.result));
  const view = await snapshot(created.code);
  assert.equal(view.event.status, 'finalized');
  assert.equal(view.event.isMutable, false);
  assert.equal(Date.parse(view.event.registrationClosesAt), closedAt);
  assert.equal(Date.parse(view.event.finalizedAt), closedAt);
  assert.equal(view.event.startAt, created.event.startAt);
  assert.equal(view.event.endAt, created.event.endAt);
  assert.equal((await app.db.query('SELECT seed FROM events WHERE code=$1', [created.code])).rows[0]!.seed, seed);
  const assignments = (data: any) => data.games.map((g: any) => ({ id: g.id, ids: g.attendees.map((p: any) => p.participantId).sort() }));
  assert.deepEqual(assignments(view), assignments(preview));
  assert.deepEqual(view.games.find((g: any) => g.id === full).attendees.map((p: any) => p.participantId), before.games[0].attendees.map((p: any) => p.participantId));
  assert.equal(view.games.find((g: any) => g.id === receiving).attendees.length, 3);
  assert.equal(view.event.result.assignedFromWaitlist, 2);
  assert.equal(view.unassigned.length, 2);
  assert.equal(view.games.reduce((n: number, g: any) => n + g.waitlist.length, 0), 0);
  const late = await participant(created.code, '提前截止后报名');
  const mutations = [
    request('POST', `/events/${created.code}/games/${full}/registrations`, late.cookie, {}),
    request('POST', `/events/${created.code}/games`, late.cookie, { name: '截止后开桌', capacity: 3 }),
    request('PATCH', `/events/${created.code}/games/${full}`, created.cookie, { capacity: 3 }),
    request('DELETE', `/events/${created.code}/games/${full}`, created.cookie),
    request('DELETE', `/events/${created.code}/my-registration`, seated.cookie),
    request('DELETE', `/events/${created.code}`, created.cookie),
  ];
  for (const mutation of await Promise.all(mutations)) assert.equal(mutation.error.code, 'EVENT_CLOSED');
  success(await request('PATCH', `/events/${created.code}`, created.cookie, { title: '提前截止后更正展示信息' }));
  now += 1000;
  assert.deepEqual(success(await request('POST', `/events/${created.code}/finalize`, created.cookie, {})).result, preview.result);
  await app.service.runHousekeeping();
  const again = await snapshot(created.code);
  assert.equal(again.event.finalizedAt, view.event.finalizedAt);
  assert.equal(again.event.registrationClosesAt, view.event.registrationClosesAt);
  assert.deepEqual(assignments(again), assignments(view));
  assert.deepEqual(again.unassigned, view.unassigned);
  assert.equal((await snapshot(other.code)).event.status, 'open');
});

test('early closure is owner-only and recovered owner authorization remains event-scoped', async () => {
  const created = await createEvent();
  const member = await participant(created.code, '提前截止权限检查');
  const outsider = await createEvent();
  success(await request('POST', `/events/${created.code}/members`, outsider.cookie, { displayName: '其他活动组织者' }));
  const path = `/events/${created.code}/finalize`;
  assert.equal((await request('POST', path)).status, 401);
  assert.equal((await request('POST', path, member.cookie, { role: 'owner', participantId: created.event.ownerId })).status, 403);
  assert.equal((await request('POST', path, outsider.cookie, {})).status, 403);
  success(await request('PUT', `/events/${created.code}/admins/${member.id}`, created.cookie, { isAdmin: true }));
  assert.equal((await request('POST', path, member.cookie, {})).status, 403);
  assert.equal((await snapshot(created.code)).event.registrationClosesAt, created.event.registrationClosesAt);
  assert.equal((await snapshot(created.code)).event.status, 'open');
  success(await request('POST', `/events/${created.code}/manage`, outsider.cookie, { managementKey: created.key }));
  success(await request('POST', path, outsider.cookie, {}));
  assert.equal((await snapshot(created.code)).event.status, 'finalized');
  assert.equal((await snapshot(outsider.code)).event.status, 'open');
});

test('normal early closure is available with test tools disabled and empty events settle as at their deadline', async () => {
  const isolated = await buildApp({ db: await openDatabase({ url: process.env.TEST_DATABASE_URL }), now: () => now, testTools: false, logger: false, publicOrigin: ORIGIN });
  try {
    await isolated.ready();
    const created = await createEvent(isolated);
    const result = success(await request('POST', `/events/${created.code}/finalize`, created.cookie, {}, isolated)).result;
    assert.deepEqual(result, { gameCount: 0, attendeeCount: 0, assignedFromWaitlist: 0, unassignedCount: 0 });
    const view = await snapshotFor(isolated, created.code, created.cookie);
    assert.equal(view.testToolsEnabled, false);
    assert.equal(view.event.status, 'finalized');
    assert.equal(view.event.isMutable, false);
    assert.equal(Date.parse(view.event.registrationClosesAt), now);
  } finally { await isolated.close(); }
});

test('manual settlement after the deadline preserves the original closing time and saved results', async () => {
  const created = await createEvent();
  await game(created.code, created.cookie, 2);
  now = Date.parse(created.event.registrationClosesAt) + 1;
  const result = success(await request('POST', `/events/${created.code}/finalize`, created.cookie, {})).result;
  assert.equal(result.attendeeCount, 1);
  const view = await snapshot(created.code);
  assert.equal(view.event.registrationClosesAt, created.event.registrationClosesAt);
  assert.equal(view.event.status, 'finalized');
  assert.deepEqual(view.event.result, result);
  now += 1000;
  success(await request('POST', `/events/${created.code}/finalize`, created.cookie, {}));
  assert.equal((await snapshot(created.code)).event.finalizedAt, view.event.finalizedAt);
});

test('registration racing manual closure is either included in the frozen snapshot or rejected', async () => {
  const created = await createEvent();
  const gameId = await game(created.code, created.cookie, 2);
  const candidate = await participant(created.code, '与提前截止并发报名');
  const [closing, registration] = await Promise.all([
    request('POST', `/events/${created.code}/finalize`, created.cookie, {}),
    join(created.code, gameId, candidate.cookie),
  ]);
  const result = success(closing).result;
  const view = await snapshot(created.code, candidate.cookie);
  assert.equal(view.event.status, 'finalized');
  if (registration.status === 200) {
    assert.equal(result.attendeeCount, 2);
    assert.equal(view.registration.finalGameId, gameId);
    assert.equal(view.registration.allocationReason, 'primary');
  } else {
    assert.equal(registration.error.code, 'EVENT_CLOSED');
    assert.equal(result.attendeeCount, 1);
    assert.equal(view.registration, null);
  }
  assert.equal((await join(created.code, gameId, candidate.cookie)).error.code, 'EVENT_CLOSED');
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

test('batch test players register only at the selected table and overflow becomes its waitlist', async () => {
  const created = await createEvent();
  const first = await game(created.code, created.cookie, 3);
  const second = success(await request('POST', `/events/${created.code}/test-games`, created.cookie, { name: '另一个测试桌', capacity: 4 }));
  const added = success(await request('POST', `/events/${created.code}/games/${first}/test-users`, created.cookie, { count: 5 }));
  assert.equal(added.createdCount, 5);
  assert.equal(added.attendeeCount, 2);
  assert.equal(added.waitlistCount, 3);
  const view = await snapshot(created.code);
  const target = view.games.find((g: any) => g.id === first);
  assert.equal(target.attendees.length, 3);
  assert.equal(target.waitlist.length, 3);
  assert.deepEqual(target.waitlist.map((p: any) => p.rank), [1, 2, 3]);
  assert.equal(view.games.find((g: any) => g.id === second.gameId).attendees.length, 1);
  const addedIds = new Set(added.participantIds);
  assert.ok(view.members.filter((m: any) => addedIds.has(m.id)).every((m: any) => m.isTest));
  assert.ok([...target.attendees.slice(1), ...target.waitlist].every((p: any) => addedIds.has(p.participantId)));
});

test('batch test player validation and event limits leave no partially created users or registrations', async () => {
  const created = await createEvent();
  const first = await game(created.code, created.cookie, 3);
  const other = await createEvent();
  const foreignGame = await game(other.code, other.cookie, 3);
  for (const count of [0, -1, 31, 1.5, 'invalid']) {
    const invalid = await request('POST', `/events/${created.code}/games/${first}/test-users`, created.cookie, { count });
    assert.equal(invalid.status, 400);
  }
  assert.equal((await request('POST', `/events/${created.code}/games/${foreignGame}/test-users`, created.cookie, { count: 3 })).status, 404);
  assert.equal((await snapshot(created.code)).members.filter((m: any) => m.isTest).length, 0);
  success(await request('POST', `/events/${created.code}/test-users`, created.cookie, { count: 30 }));
  success(await request('POST', `/events/${created.code}/test-users`, created.cookie, { count: 19 }));
  const overflow = await request('POST', `/events/${created.code}/games/${first}/test-users`, created.cookie, { count: 2 });
  assert.equal(overflow.status, 400);
  const after = await snapshot(created.code);
  assert.equal(after.members.filter((m: any) => m.isTest).length, 49);
  assert.equal(after.games[0].attendees.length, 1);
  assert.equal(after.games[0].waitlist.length, 0);
});

test('one-click test settlement matches preview, freezes registration and is idempotent before the scheduled deadline', async () => {
  const created = await createEvent();
  const full = await game(created.code, created.cookie, 1);
  success(await request('POST', `/events/${created.code}/test-games`, created.cookie, { name: '接收候补的测试桌', capacity: 3 }));
  success(await request('POST', `/events/${created.code}/games/${full}/test-users`, created.cookie, { count: 4 }));
  const other = await createEvent();
  const preview = success(await request('POST', `/events/${created.code}/preview`, created.cookie, {}));
  assert.ok(now < Date.parse(created.event.registrationClosesAt));
  const results = await Promise.all([
    request('POST', `/events/${created.code}/test-finalize`, created.cookie, {}),
    request('POST', `/events/${created.code}/test-finalize`, created.cookie, {}),
  ]);
  results.forEach((result) => assert.deepEqual(success(result).result, preview.result));
  const view = await snapshot(created.code);
  assert.equal(view.event.status, 'finalized');
  assert.equal(view.event.isMutable, false);
  assert.equal(Date.parse(view.event.registrationClosesAt), now);
  assert.equal(view.event.startAt, created.event.startAt);
  assert.equal(view.event.endAt, created.event.endAt);
  assert.equal(view.event.result.assignedFromWaitlist, 2);
  assert.equal(view.unassigned.length, 2);
  const assignments = (data: any) => data.games.map((g: any) => ({ id: g.id, ids: g.attendees.map((p: any) => p.participantId).sort() }));
  assert.deepEqual(assignments(view), assignments(preview));
  assert.equal(view.games.reduce((n: number, g: any) => n + g.waitlist.length, 0), 0);
  const late = await participant(created.code, '测试分桌后报名');
  assert.equal((await join(created.code, full, late.cookie)).error.code, 'EVENT_CLOSED');
  assert.equal((await request('POST', `/events/${created.code}/games/${full}/test-users`, created.cookie, { count: 1 })).error.code, 'EVENT_CLOSED');
  success(await request('POST', `/events/${created.code}/test-finalize`, created.cookie, {}));
  const again = await snapshot(created.code);
  assert.equal(again.event.finalizedAt, view.event.finalizedAt);
  assert.deepEqual(assignments(again), assignments(view));
  assert.equal((await snapshot(other.code)).event.status, 'open');
});

test('test settlement rejects an empty event without changing its deadline', async () => {
  const created = await createEvent();
  assert.equal((await request('POST', `/events/${created.code}/test-finalize`, created.cookie, {})).status, 400);
  const view = await snapshot(created.code);
  assert.equal(view.event.status, 'open');
  assert.equal(view.event.registrationClosesAt, created.event.registrationClosesAt);
});

test('batch test registration and early settlement require this event owner, including for admins', async () => {
  const created = await createEvent();
  const first = await game(created.code, created.cookie, 3);
  const person = await participant(created.code, '测试功能权限检查');
  const paths = [`/events/${created.code}/games/${first}/test-users`, `/events/${created.code}/test-finalize`];
  for (const path of paths) {
    assert.equal((await request('POST', path, '', { count: 1 })).status, 401);
    assert.equal((await request('POST', path, person.cookie, { count: 1 })).status, 403);
  }
  success(await request('PUT', `/events/${created.code}/admins/${person.id}`, created.cookie, { isAdmin: true }));
  const outsider = await createEvent();
  for (const path of paths) {
    assert.equal((await request('POST', path, person.cookie, { count: 1 })).status, 403);
    assert.equal((await request('POST', path, outsider.cookie, { count: 1 })).status, 401);
  }
  assert.equal((await snapshot(created.code)).event.status, 'open');
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
    for (const path of [`/events/${created.code}/games/${randomUUID()}/test-users`, `/events/${created.code}/test-finalize`]) {
      assert.equal((await request('POST', path, created.cookie, { count: 1 }, isolated)).status, 403);
    }
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
