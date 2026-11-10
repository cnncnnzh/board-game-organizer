import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database, Queryable, Row } from './db.js';
import { type Actor, hashSecret, newSecret } from './identity.js';
import { AppError, assert, validateName, validateEvent, validateGame } from './domain/validation.js';
import { allocateWaitlist } from './domain/allocation.js';

const DAY = 86400000;
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const nameKey = (name: string) => name.normalize('NFKC').toLocaleLowerCase('en-US');
const iso = (v: Date | string | null) => v ? new Date(v).toISOString() : null;
export function normalizeCode(value: unknown) {
  const code = String(value ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
  assert(/^[A-HJ-NP-Z2-9]{8}$/.test(code), 'INVALID_CODE', '请输入 8 位活动码', 400);
  return code;
}
export class EventService {
  constructor(public db: Database, private now = Date.now, public testTools = false) {}

  private async locked(tx: Queryable, code: string) {
    const row = (await tx.query('SELECT * FROM events WHERE code=$1 FOR UPDATE', [normalizeCode(code)])).rows[0];
    assert(row, 'NOT_FOUND', '活动不存在或已过期清理', 404);
    return row;
  }
  private mutable(event: Row) {
    assert(event.status === 'open' && this.now() < new Date(event.registration_closes_at).getTime(),
      'EVENT_CLOSED', '活动已截止，不能修改桌游或报名', 409);
  }
  private async member(tx: Queryable, event: Row, actor: Actor | null): Promise<Row | null> {
    if (!actor) return null;
    const grant = (await tx.query(`SELECT participant_id FROM event_grants WHERE token_hash=$1 AND event_id=$2 AND key_version=$3`,
      [actor.sessionHash, event.id, event.key_version])).rows[0];
    const id = grant?.participant_id || actor.participantId;
    return (await tx.query(`SELECT m.*,p.is_test,p.is_test_host FROM event_members m JOIN participants p ON p.id=m.participant_id
      WHERE m.event_id=$1 AND m.participant_id=$2`, [event.id, id])).rows[0] ?? null;
  }
  private role(event: Row, member: Row | null) {
    return !member ? 'guest' : member.participant_id === event.owner_id ? 'owner' : member.is_admin ? 'admin' : 'member';
  }
  private async requireMember(tx: Queryable, event: Row, actor: Actor | null, roles?: string[]) {
    const member = await this.member(tx, event, actor);
    assert(member, 'NAME_REQUIRED', '请先填写姓名或微信名进入活动', 401);
    if (roles) assert(roles.includes(this.role(event, member)), 'FORBIDDEN', '你没有执行此操作的权限', 403);
    return member;
  }
  private async addMember(tx: Queryable, eventId: string, participantId: string, value: unknown) {
    const name = validateName(value);
    const collision = (await tx.query('SELECT participant_id FROM event_members WHERE event_id=$1 AND name_key=$2', [eventId, nameKey(name)])).rows[0];
    assert(!collision || collision.participant_id === participantId, 'NAME_TAKEN', '这个姓名已在活动中使用，请加上可辨认的后缀；姓名不能用于找回他人的报名', 409);
    await tx.query(`INSERT INTO event_members(event_id,participant_id,display_name,name_key) VALUES($1,$2,$3,$4)
      ON CONFLICT(event_id,participant_id) DO UPDATE SET display_name=excluded.display_name,name_key=excluded.name_key`,
    [eventId, participantId, name, nameKey(name)]);
  }
  async createEvent(actor: Actor, payload: Row) {
    const values = validateEvent(payload, { now: this.now() });
    const id = randomUUID(), managementKey = newSecret();
    const name = payload.displayName ?? (await this.db.query('SELECT display_name FROM participants WHERE id=$1', [actor.participantId])).rows[0]?.display_name;
    return this.db.transaction(async (tx) => {
      for (let retry = 0; retry < 5; retry++) {
        const code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
        const row = (await tx.query(`INSERT INTO events(id,code,owner_id,title,location,start_at,end_at,time_zone,registration_closes_at,seed,management_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(code) DO NOTHING RETURNING *`,
        [id, code, actor.participantId, values.title, values.location, values.startAt, values.endAt, values.timeZone,
          values.registrationClosesAt, `${id}:${Date.parse(values.registrationClosesAt)}`, hashSecret(managementKey)])).rows[0];
        if (!row) continue;
        await this.addMember(tx, id, actor.participantId, name);
        return { event: this.eventDto(row, 'owner'), managementKey };
      }
      throw new AppError('CODE_GENERATION_FAILED', '活动码生成失败，请重试', 503);
    });
  }
  async resolve(code: string) {
    const value = normalizeCode(code);
    const row = (await this.db.query('SELECT code FROM events WHERE code=$1', [value])).rows[0];
    assert(row, 'NOT_FOUND', '活动不存在或已过期清理', 404);
    return { code: value };
  }
  async joinEvent(code: string, actor: Actor, payload: Row) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      const existing = await this.member(tx, event, actor);
      // A recovered identity is scoped to this event, including its display name.
      await this.addMember(tx, event.id, existing?.participant_id ?? actor.participantId, payload.displayName);
      return { joined: true };
    });
  }
  private eventDto(event: Row, role: string) {
    return { id: event.id, code: event.code, title: event.title, location: event.location,
      startAt: iso(event.start_at), endAt: iso(event.end_at), timeZone: event.time_zone,
      registrationClosesAt: iso(event.registration_closes_at), status: event.status,
      finalizedAt: iso(event.finalized_at), ownerId: event.owner_id, result: event.result,
      role, canManage: ['owner', 'admin'].includes(role),
      isMutable: event.status === 'open' && this.now() < new Date(event.registration_closes_at).getTime() };
  }
  private async data(tx: Queryable, eventId: string) {
    const games = (await tx.query('SELECT * FROM games WHERE event_id=$1 ORDER BY position', [eventId])).rows;
    const registrations = (await tx.query(`SELECT r.*,m.display_name FROM registrations r JOIN event_members m
      ON r.event_id=m.event_id AND r.participant_id=m.participant_id WHERE r.event_id=$1 ORDER BY r.id`, [eventId])).rows;
    return { games, registrations };
  }
  private calculate(event: Row, games: Row[], registrations: Row[]) {
    return allocateWaitlist({
      games: games.map((g) => ({ id: g.id, name: g.name, capacity: g.capacity,
        attendees: registrations.filter((r) => r.status === 'attendee' && (r.final_game_id || r.primary_game_id) === g.id)
          .map((r) => ({ participantId: r.participant_id })) })),
      registrations: registrations.map((r) => ({ participantId: r.participant_id, status: r.status, secondaryGameId: r.secondary_game_id })), seed: event.seed,
    });
  }
  private summary(games: Row[], registrations: Row[]) {
    return { gameCount: games.length, attendeeCount: registrations.filter((r) => r.status === 'attendee').length,
      assignedFromWaitlist: registrations.filter((r) => r.allocation_reason === 'balanced').length,
      unassignedCount: registrations.filter((r) => r.status === 'unassigned').length };
  }
  private async finalizeLocked(tx: Queryable, event: Row) {
    if (event.status !== 'open' || this.now() < new Date(event.registration_closes_at).getTime()) return false;
    const { games, registrations } = await this.data(tx, event.id);
    const result = this.calculate(event, games, registrations);
    const assignments = new Map(result.assignments.map((a) => [a.participantId, a]));
    for (const registration of registrations) {
      const assigned = assignments.get(registration.participant_id);
      const wasAttendee = registration.status === 'attendee';
      const status = wasAttendee || assigned ? 'attendee' : 'unassigned';
      const finalId = wasAttendee ? registration.primary_game_id : assigned?.gameId ?? null;
      const reason = wasAttendee ? 'primary' : assigned ? 'balanced' : null;
      await tx.query('UPDATE registrations SET status=$1,final_game_id=$2,allocation_reason=$3 WHERE id=$4', [status, finalId, reason, registration.id]);
      Object.assign(registration, { status, final_game_id: finalId, allocation_reason: reason });
    }
    const summary = this.summary(games, registrations);
    const finalizedAt = new Date(this.now()).toISOString();
    await tx.query("UPDATE events SET status='finalized',finalized_at=$1,result=$2,updated_at=clock_timestamp() WHERE id=$3", [finalizedAt, JSON.stringify(summary), event.id]);
    Object.assign(event, { status: 'finalized', finalized_at: finalizedAt, result: summary });
    return true;
  }
  private async closeAndFinalizeLocked(tx: Queryable, event: Row) {
    if (event.status === 'open') {
      const now = this.now();
      // Keep the seed so this snapshot produces the same result as at the scheduled deadline.
      if (now < new Date(event.registration_closes_at).getTime()) {
        event.registration_closes_at = new Date(now).toISOString();
        await tx.query('UPDATE events SET registration_closes_at=$1 WHERE id=$2', [event.registration_closes_at, event.id]);
      }
      await this.finalizeLocked(tx, event);
    }
    return { result: event.result };
  }
  async finalizeEvent(code: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      await this.requireMember(tx, event, actor, ['owner']);
      return this.closeAndFinalizeLocked(tx, event);
    });
  }
  async view(code: string, actor: Actor | null) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      await this.finalizeLocked(tx, event);
      const member = await this.member(tx, event, actor);
      const role = this.role(event, member);
      const { games, registrations } = await this.data(tx, event.id);
      const members = (await tx.query(`SELECT m.*,p.is_test FROM event_members m JOIN participants p ON p.id=m.participant_id
        WHERE m.event_id=$1 ORDER BY m.display_name,m.participant_id`, [event.id])).rows;
      const byId = new Map(members.map((m) => [m.participant_id, m]));
      const myRegistration = registrations.find((r) => r.participant_id === member?.participant_id);
      const registrationDto = (r: Row) => ({ id: String(r.id), participantId: r.participant_id, displayName: r.display_name,
        primaryGameId: r.primary_game_id, finalGameId: r.final_game_id, status: r.status, isHost: r.is_host, allocationReason: r.allocation_reason });
      return {
        event: this.eventDto(event, role), currentParticipantId: member?.participant_id ?? null,
        participant: member ? { id: member.participant_id, displayName: member.display_name } : null,
        registration: myRegistration ? { ...registrationDto(myRegistration), secondaryGameId: myRegistration.secondary_game_id } : null,
        games: games.map((g) => ({ id: g.id, name: g.name, capacity: g.capacity, description: g.description, difficulty: g.difficulty,
          hostId: g.host_id, hostName: byId.get(g.host_id)?.display_name ?? '', isHost: g.host_id === member?.participant_id,
          attendees: registrations.filter((r) => r.status === 'attendee' && (r.final_game_id || r.primary_game_id) === g.id).map(registrationDto),
          waitlist: registrations.filter((r) => r.status === 'waitlist' && r.primary_game_id === g.id).map((r, i) => ({ ...registrationDto(r), rank: i + 1 })) })),
        unassigned: registrations.filter((r) => r.status === 'unassigned').map(registrationDto),
        members: members.map((m) => ({ id: m.participant_id, displayName: m.display_name, role: this.role(event, m), isTest: m.is_test })),
        testToolsEnabled: this.testTools && role === 'owner', serverTime: this.now(),
      };
    });
  }
  async updateEvent(code: string, actor: Actor, payload: Row) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      await this.requireMember(tx, event, actor, ['owner', 'admin']);
      if (event.status === 'open') this.mutable(event);
      const values = validateEvent({ title: event.title, location: event.location, startAt: iso(event.start_at), endAt: iso(event.end_at), timeZone: event.time_zone, ...payload },
        { now: this.now(), requireFutureStart: event.status !== 'finalized' });
      const closes = event.status === 'finalized' ? iso(event.registration_closes_at)! : values.registrationClosesAt;
      await tx.query(`UPDATE events SET title=$1,location=$2,start_at=$3,end_at=$4,time_zone=$5,registration_closes_at=$6,seed=$7,updated_at=clock_timestamp() WHERE id=$8`,
        [values.title, values.location, values.startAt, values.endAt, values.timeZone, closes,
          event.status === 'finalized' ? event.seed : `${event.id}:${Date.parse(closes)}`, event.id]);
      return { updated: true };
    });
  }
  async deleteEvent(code: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      await this.requireMember(tx, event, actor, ['owner', 'admin']);
      this.mutable(event);
      await tx.query('DELETE FROM events WHERE id=$1', [event.id]);
      return { deleted: true };
    });
  }
  private async requireGame(tx: Queryable, eventId: string, gameId: string) {
    const game = (await tx.query('SELECT * FROM games WHERE event_id=$1 AND id=$2', [eventId, gameId])).rows[0];
    assert(game, 'NOT_FOUND', '桌游不存在', 404);
    return game;
  }
  private async createGameInTx(tx: Queryable, event: Row, member: Row, payload: Row) {
    this.mutable(event);
    assert(!member.is_test || member.is_test_host, 'FORBIDDEN', '请通过测试 Host 入口创建测试桌游', 403);
    const values = validateGame(payload);
    const registration = (await tx.query('SELECT id FROM registrations WHERE event_id=$1 AND participant_id=$2', [event.id, member.participant_id])).rows[0];
    assert(!registration, 'ALREADY_REGISTERED', '你已有报名，退出后才能创建桌游', 409);
    const id = randomUUID();
    await tx.query('INSERT INTO games(id,event_id,host_id,name,capacity,description,difficulty) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, event.id, member.participant_id, values.name, values.capacity, values.description, values.difficulty]);
    await tx.query("INSERT INTO registrations(event_id,participant_id,primary_game_id,status,is_host) VALUES($1,$2,$3,'attendee',true)", [event.id, member.participant_id, id]);
    return { gameId: id };
  }
  async createGame(code: string, actor: Actor, payload: Row) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      const member = await this.requireMember(tx, event, actor);
      return this.createGameInTx(tx, event, member, payload);
    });
  }
  private async fillSeats(tx: Queryable, eventId: string, gameId: string, capacity: number) {
    const rows = (await tx.query("SELECT id,status FROM registrations WHERE event_id=$1 AND primary_game_id=$2 ORDER BY id", [eventId, gameId])).rows;
    const available = Math.max(0, capacity - rows.filter((r) => r.status === 'attendee').length);
    const waiting = rows.filter((r) => r.status === 'waitlist').slice(0, available);
    for (const r of waiting) await tx.query("UPDATE registrations SET status='attendee',secondary_game_id=NULL WHERE id=$1", [r.id]);
    return waiting.length;
  }
  async updateGame(code: string, gameId: string, actor: Actor, payload: Row) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      this.mutable(event);
      const member = await this.requireMember(tx, event, actor);
      const game = await this.requireGame(tx, event.id, gameId);
      assert(game.host_id === member.participant_id, 'FORBIDDEN', '只有 host 可以修改这个桌游', 403);
      const values = validateGame({ ...game, ...payload });
      const count = (await tx.query("SELECT count(*)::int AS count FROM registrations WHERE event_id=$1 AND primary_game_id=$2 AND status='attendee'", [event.id, gameId])).rows[0]!.count;
      assert(values.capacity >= count, 'INVALID_INPUT', '人数上限不能低于当前入席人数');
      await tx.query('UPDATE games SET name=$1,capacity=$2,description=$3,difficulty=$4 WHERE event_id=$5 AND id=$6',
        [values.name, values.capacity, values.description, values.difficulty, event.id, gameId]);
      const promotedCount = await this.fillSeats(tx, event.id, gameId, values.capacity);
      return { gameId, promotedCount };
    });
  }
  async deleteGame(code: string, gameId: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      this.mutable(event);
      const member = await this.requireMember(tx, event, actor);
      const game = await this.requireGame(tx, event.id, gameId);
      assert(game.host_id === member.participant_id, 'FORBIDDEN', '只有 host 可以删除这个桌游', 403);
      await tx.query('DELETE FROM games WHERE event_id=$1 AND id=$2', [event.id, gameId]);
      return { deleted: true };
    });
  }
  private async joinGameInTx(tx: Queryable, event: Row, member: Row, gameId: string) {
    this.mutable(event);
    const game = await this.requireGame(tx, event.id, gameId);
    const existing = (await tx.query('SELECT id FROM registrations WHERE event_id=$1 AND participant_id=$2', [event.id, member.participant_id])).rows[0];
    assert(!existing, 'ALREADY_REGISTERED', '每人只能选择一桌，请先退出当前报名', 409);
    const count = (await tx.query("SELECT count(*)::int AS count FROM registrations WHERE event_id=$1 AND primary_game_id=$2 AND status='attendee'", [event.id, gameId])).rows[0]!.count;
    const status = count < game.capacity ? 'attendee' : 'waitlist';
    await tx.query('INSERT INTO registrations(event_id,participant_id,primary_game_id,status) VALUES($1,$2,$3,$4)', [event.id, member.participant_id, gameId, status]);
    return { gameId, status };
  }
  async joinGame(code: string, gameId: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      return this.joinGameInTx(tx, event, await this.requireMember(tx, event, actor), gameId);
    });
  }
  async updateSecondChoice(code: string, actor: Actor, secondaryGameId: unknown) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      this.mutable(event);
      const member = await this.requireMember(tx, event, actor);
      const registration = (await tx.query('SELECT * FROM registrations WHERE event_id=$1 AND participant_id=$2',
        [event.id, member.participant_id])).rows[0];
      assert(registration, 'NOT_FOUND', '你还没有报名', 404);
      assert(registration.status === 'waitlist', 'NOT_WAITLISTED', '只有候补玩家可以设置第二选择', 409);
      assert(secondaryGameId === null || (typeof secondaryGameId === 'string' && secondaryGameId.trim().length > 0),
        'INVALID_INPUT', '请选择第二选择桌游，或设为 null 取消');
      if (secondaryGameId !== null) {
        assert(secondaryGameId !== registration.primary_game_id, 'INVALID_INPUT', '第二选择不能与第一选择相同');
        await this.requireGame(tx, event.id, secondaryGameId as string);
      }
      await tx.query('UPDATE registrations SET secondary_game_id=$1 WHERE id=$2', [secondaryGameId, registration.id]);
      return { secondaryGameId };
    });
  }
  private async dropInTx(tx: Queryable, event: Row, member: Row) {
    this.mutable(event);
    const registration = (await tx.query('SELECT * FROM registrations WHERE event_id=$1 AND participant_id=$2', [event.id, member.participant_id])).rows[0];
    assert(registration, 'NOT_FOUND', '你还没有报名', 404);
    assert(!registration.is_host, 'HOST_MUST_DELETE', 'host 退出需删除自己创建的桌游', 409);
    await tx.query('DELETE FROM registrations WHERE id=$1', [registration.id]);
    const game = await this.requireGame(tx, event.id, registration.primary_game_id);
    const promotedCount = await this.fillSeats(tx, event.id, game.id, game.capacity);
    return { dropped: true, promotedCount };
  }
  async dropGame(code: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      return this.dropInTx(tx, event, await this.requireMember(tx, event, actor));
    });
  }
  private async rotateKey(tx: Queryable, eventId: string) {
    const managementKey = newSecret();
    await tx.query('UPDATE events SET management_hash=$1,key_version=key_version+1 WHERE id=$2', [hashSecret(managementKey), eventId]);
    await tx.query('DELETE FROM event_grants WHERE event_id=$1', [eventId]);
    return { managementKey };
  }
  async recover(code: string, actor: Actor, key: unknown) {
    assert(typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key), 'INVALID_KEY', '管理恢复密钥不正确', 403);
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      assert(timingSafeEqual(Buffer.from(hashSecret(key), 'hex'), Buffer.from(event.management_hash, 'hex')), 'INVALID_KEY', '管理恢复密钥不正确', 403);
      await tx.query(`INSERT INTO event_grants(token_hash,event_id,participant_id,key_version) VALUES($1,$2,$3,$4)
        ON CONFLICT(token_hash,event_id) DO UPDATE SET participant_id=excluded.participant_id,key_version=excluded.key_version`,
      [actor.sessionHash, event.id, event.owner_id, event.key_version]);
      return { recovered: true };
    });
  }
  async rotateManagementKey(code: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      const member = await this.requireMember(tx, event, actor, ['owner']);
      const result = await this.rotateKey(tx, event.id);
      // Keep this recovering browser authorized; other recovered sessions are revoked.
      if (member.participant_id !== actor.participantId) {
        await tx.query('INSERT INTO event_grants(token_hash,event_id,participant_id,key_version) VALUES($1,$2,$3,$4)',
          [actor.sessionHash, event.id, member.participant_id, event.key_version + 1]);
      }
      return result;
    });
  }
  async setAdmin(code: string, actor: Actor, targetId: string, isAdmin: unknown) {
    assert(typeof isAdmin === 'boolean', 'INVALID_INPUT', '管理员状态必须为布尔值');
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      await this.requireMember(tx, event, actor, ['owner']);
      assert(targetId !== event.owner_id, 'INVALID_INPUT', '不能更改 owner 的管理员身份');
      const target = (await tx.query('SELECT p.is_test FROM event_members m JOIN participants p ON p.id=m.participant_id WHERE m.event_id=$1 AND m.participant_id=$2', [event.id, targetId])).rows[0];
      assert(target, 'NOT_FOUND', '请选择本活动成员', 404);
      assert(!target.is_test, 'INVALID_INPUT', '测试用户不能成为管理员');
      await tx.query('UPDATE event_members SET is_admin=$1 WHERE event_id=$2 AND participant_id=$3', [isAdmin, event.id, targetId]);
      return { updated: true };
    });
  }
  async transferOwner(code: string, actor: Actor, targetId: string) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      await this.requireMember(tx, event, actor, ['owner']);
      const target = (await tx.query('SELECT p.is_test FROM event_members m JOIN participants p ON p.id=m.participant_id WHERE m.event_id=$1 AND m.participant_id=$2', [event.id, targetId])).rows[0];
      assert(target && targetId !== event.owner_id, 'INVALID_INPUT', '请选择另一名本活动成员');
      assert(!target.is_test, 'INVALID_INPUT', '测试用户不能成为 owner');
      await tx.query('UPDATE event_members SET is_admin=true WHERE event_id=$1 AND participant_id=$2', [event.id, event.owner_id]);
      await tx.query('UPDATE event_members SET is_admin=false WHERE event_id=$1 AND participant_id=$2', [event.id, targetId]);
      await tx.query('UPDATE events SET owner_id=$1 WHERE id=$2', [targetId, event.id]);
      // Never return the new owner's key to the previous owner.
      await this.rotateKey(tx, event.id);
      return { ownerId: targetId };
    });
  }
  private async requireTest(tx: Queryable, event: Row, actor: Actor) {
    await this.requireMember(tx, event, actor, ['owner']);
    assert(this.testTools, 'TEST_TOOLS_DISABLED', '当前环境未启用测试工具', 403);
  }
  async preview(code: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      await this.requireTest(tx, event, actor);
      assert(event.status === 'open', 'EVENT_CLOSED', '活动已分配，请查看最终结果', 409);
      const { games, registrations } = await this.data(tx, event.id);
      const allocation = this.calculate(event, games, registrations);
      const byId = new Map(registrations.map((r) => [r.participant_id, r]));
      const mapped = games.map((g) => ({ id: g.id, name: g.name, capacity: g.capacity,
        attendees: registrations.filter((r) => r.status === 'attendee' && r.primary_game_id === g.id)
          .map((r) => ({ participantId: r.participant_id, displayName: r.display_name, reason: r.is_host ? 'host' : 'primary' }))
          .concat(allocation.assignments.filter((a) => a.gameId === g.id).map((a) => ({ participantId: a.participantId, displayName: byId.get(a.participantId)!.display_name, reason: 'balanced' }))) }));
      return { games: mapped, unassigned: allocation.unassigned.map((id) => ({ participantId: id, displayName: byId.get(id)!.display_name })),
        result: { gameCount: games.length, attendeeCount: mapped.reduce((n, g) => n + g.attendees.length, 0), assignedFromWaitlist: allocation.assignments.length, unassignedCount: allocation.unassigned.length } };
    });
  }
  async finalizeTestEvent(code: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      await this.requireTest(tx, event, actor);
      if (event.status === 'open') {
        const games = (await tx.query('SELECT id FROM games WHERE event_id=$1', [event.id])).rows;
        assert(games.length, 'INVALID_INPUT', '请先创建至少一个桌游');
      }
      return this.closeAndFinalizeLocked(tx, event);
    });
  }
  private async testMember(tx: Queryable, eventId: string, id: string) {
    const member = (await tx.query(`SELECT m.*,p.is_test,p.is_test_host FROM event_members m JOIN participants p ON p.id=m.participant_id
      WHERE m.event_id=$1 AND m.participant_id=$2 AND p.is_test`, [eventId, id])).rows[0];
    assert(member, 'NOT_FOUND', '测试用户不存在', 404);
    return member;
  }
  async createTestUsers(code: string, actor: Actor, count: unknown, { hostGame, gameId }: { hostGame?: Row; gameId?: string } = {}) {
    const number = hostGame ? 1 : Number(count);
    assert(Number.isInteger(number) && number >= 1 && number <= 30, 'INVALID_INPUT', '单次创建数量为 1–30');
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      await this.requireTest(tx, event, actor);
      this.mutable(event);
      if (gameId) await this.requireGame(tx, event.id, gameId);
      const total = (await tx.query('SELECT count(*)::int AS count FROM event_members m JOIN participants p ON p.id=m.participant_id WHERE m.event_id=$1 AND p.is_test', [event.id])).rows[0]!.count;
      assert(total + number <= 50, 'INVALID_INPUT', '每个活动最多 50 个测试用户');
      const ids: string[] = [];
      let gameResult: { gameId: string } | undefined;
      let attendeeCount = 0, waitlistCount = 0;
      for (let i = 0; i < number; i++) {
        const id = randomUUID();
        const name = `${hostGame ? '测试host' : '测试玩家'} ${id.slice(0, 8)}`;
        await tx.query('INSERT INTO participants(id,display_name,is_test,is_test_host,test_created_by) VALUES($1,$2,true,$3,$4)', [id, name, Boolean(hostGame), event.owner_id]);
        await this.addMember(tx, event.id, id, name);
        ids.push(id);
        if (hostGame) gameResult = await this.createGameInTx(tx, event, { participant_id: id, is_test: true, is_test_host: true }, hostGame);
        if (gameId) {
          const registration = await this.joinGameInTx(tx, event, { participant_id: id }, gameId);
          if (registration.status === 'attendee') attendeeCount++; else waitlistCount++;
        }
      }
      return { createdCount: number, participantIds: ids, ...gameResult,
        ...(gameId ? { gameId, attendeeCount, waitlistCount } : {}) };
    });
  }
  async joinTestUser(code: string, actor: Actor, targetId: string, gameId: string) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      await this.requireTest(tx, event, actor);
      return this.joinGameInTx(tx, event, await this.testMember(tx, event.id, targetId), gameId);
    });
  }
  async dropTestUser(code: string, actor: Actor, targetId: string) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      await this.requireTest(tx, event, actor);
      return this.dropInTx(tx, event, await this.testMember(tx, event.id, targetId));
    });
  }
  async fillTestUsers(code: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      await this.requireTest(tx, event, actor);
      this.mutable(event);
      const games = (await this.data(tx, event.id)).games;
      assert(games.length, 'INVALID_INPUT', '请先创建至少一个桌游');
      const waiting = (await tx.query(`SELECT m.*,p.is_test FROM event_members m JOIN participants p ON p.id=m.participant_id
        LEFT JOIN registrations r ON r.event_id=m.event_id AND r.participant_id=m.participant_id
        WHERE m.event_id=$1 AND p.is_test AND r.id IS NULL ORDER BY m.display_name,m.participant_id`, [event.id])).rows;
      let attendeeCount = 0, waitlistCount = 0;
      for (let i = 0; i < waiting.length; i++) {
        const result = await this.joinGameInTx(tx, event, waiting[i]!, games[i % games.length]!.id);
        if (result.status === 'attendee') attendeeCount++; else waitlistCount++;
      }
      return { joinedCount: waiting.length, attendeeCount, waitlistCount };
    });
  }
  async clearTestUsers(code: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      await this.requireTest(tx, event, actor);
      const testIds = (await tx.query('SELECT p.id FROM participants p JOIN event_members m ON m.participant_id=p.id WHERE m.event_id=$1 AND p.is_test', [event.id])).rows;
      // Membership cascades remove test-hosted games and all registrations on those games.
      for (const p of testIds) {
        await tx.query('DELETE FROM event_members WHERE event_id=$1 AND participant_id=$2', [event.id, p.id]);
        await tx.query('DELETE FROM participants WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM event_members WHERE participant_id=$1)', [p.id]);
      }
      const { games } = await this.data(tx, event.id);
      if (event.status === 'open' && this.now() < new Date(event.registration_closes_at).getTime()) {
        for (const g of games) await this.fillSeats(tx, event.id, g.id, g.capacity);
      }
      if (event.status === 'finalized') {
        const data = await this.data(tx, event.id);
        await tx.query('UPDATE events SET result=$1 WHERE id=$2', [JSON.stringify(this.summary(data.games, data.registrations)), event.id]);
      }
      return { deletedUserCount: testIds.length };
    });
  }
  async clearTestEvent(code: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      await this.requireTest(tx, event, actor);
      await tx.query(`UPDATE participants SET test_created_by=$1 WHERE is_test AND id IN
        (SELECT participant_id FROM event_members WHERE event_id=$2)`, [event.owner_id, event.id]);
      await tx.query('DELETE FROM events WHERE id=$1', [event.id]);
      return { deleted: true, testUsersRetained: true };
    });
  }
  async reuseTestUsers(code: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const event = await this.locked(tx, code);
      await this.requireTest(tx, event, actor);
      this.mutable(event);
      // Serialize access to the owner's orphan pool across their independent events.
      await tx.query('SELECT id FROM participants WHERE id=$1 FOR UPDATE', [event.owner_id]);
      const total = (await tx.query('SELECT count(*)::int AS count FROM event_members m JOIN participants p ON p.id=m.participant_id WHERE m.event_id=$1 AND p.is_test', [event.id])).rows[0]!.count;
      const pool = (await tx.query(`SELECT p.* FROM participants p WHERE p.is_test AND p.test_created_by=$1
        AND NOT EXISTS(SELECT 1 FROM event_members m WHERE m.participant_id=p.id) ORDER BY p.created_at,p.id LIMIT $2`, [event.owner_id, Math.max(0, 50 - total)])).rows;
      for (const p of pool) await this.addMember(tx, event.id, p.id, p.display_name);
      return { reusedCount: pool.length };
    });
  }
  async runHousekeeping() {
    const finalized: string[] = [], deleted: string[] = [];
    const events = (await this.db.query('SELECT code FROM events ORDER BY created_at,id')).rows;
    for (const row of events) {
      await this.db.transaction(async (tx) => {
        const event = (await tx.query('SELECT * FROM events WHERE code=$1 FOR UPDATE', [row.code])).rows[0];
        if (!event) return;
        if (this.now() >= new Date(event.end_at).getTime() + DAY) {
          await tx.query('DELETE FROM events WHERE id=$1', [event.id]);
          deleted.push(event.code);
        } else if (await this.finalizeLocked(tx, event)) finalized.push(event.code);
      });
    }
    await this.db.query('DELETE FROM sessions WHERE expires_at<=clock_timestamp()');
    return { finalized, deleted };
  }
}
