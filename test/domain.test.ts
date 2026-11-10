import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateWaitlist, seededRandom, shuffle, type AllocationGame } from '../src/domain/allocation.js';
import { AppError, validateEvent, validateGame, validateName } from '../src/domain/validation.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-08T18:00:00Z');
function game(id: string, capacity: number, participants: string[] = []): AllocationGame {
  return { id, name: id, capacity, attendees: participants.map((participantId) => ({ participantId })) };
}
function waiting(participantId: string) { return { participantId, status: 'waitlist' }; }
function event(startAt = new Date(NOW + 2 * DAY).toISOString(), endAt = new Date(NOW + 2 * DAY + 4 * 3600000).toISOString()) {
  return { title: '周末桌游', location: 'Chicago', startAt, endAt, timeZone: 'America/Chicago' };
}

test('seeded shuffle is reproducible and does not modify its input', () => {
  const input = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(shuffle(input, seededRandom('same')), shuffle(input, seededRandom('same')));
  assert.deepEqual(input, ['a', 'b', 'c', 'd', 'e']);
});

test('allocation preserves existing attendees and does not mutate input', () => {
  const games = [game('a', 3, ['host-a', 'member-a']), game('b', 3, ['host-b'])];
  const original = structuredClone(games);
  const result = allocateWaitlist({ games, registrations: [{ participantId: 'existing', status: 'attendee' }, waiting('waiting')], seed: 'same' });
  assert.deepEqual(result.assignments, [{ participantId: 'waiting', gameId: 'b', reason: 'balanced' }]);
  assert.deepEqual(games, original);
});

test('allocation chooses fewer attendees, rather than more spare capacity', () => {
  for (let run = 0; run < 40; run++) {
    const result = allocateWaitlist({ games: [game('large', 100, ['h1', 'm1', 'm2']), game('small', 2, ['h2'])], registrations: [waiting('w')], seed: String(run) });
    assert.equal(result.assignments[0]!.gameId, 'small');
  }
});

test('allocation rebalances after every assignment', () => {
  const result = allocateWaitlist({ games: [game('a', 6, ['h1', 'a1', 'a2', 'a3']), game('b', 6, ['h2']), game('c', 6, ['h3', 'c1'])], registrations: Array.from({ length: 5 }, (_, i) => waiting(`w${i}`)), seed: 'catch-up' });
  assert.equal(result.assignments[0]!.gameId, 'b');
  assert.deepEqual(result.gameState.map((g) => g.attendeeParticipantIds.length), [4, 4, 4]);
  assert.equal(result.openSeatCount, 11);
});

test('equal-size tables are selected randomly across different seeds', () => {
  const destinations = new Set<string>();
  for (let run = 0; run < 40; run++) {
    const result = allocateWaitlist({ games: [game('a', 2, ['ha']), game('b', 4, ['hb'])], registrations: [waiting('w')], seed: String(run) });
    destinations.add(result.assignments[0]!.gameId);
  }
  assert.equal(destinations.size, 2);
});

test('full tables are excluded, overflowing candidates remain unassigned', () => {
  const result = allocateWaitlist({ games: [game('full', 1, ['ha']), game('one-seat', 2, ['hb'])], registrations: [waiting('a'), waiting('b'), waiting('c')], seed: 'limited' });
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0]!.gameId, 'one-seat');
  assert.equal(result.unassigned.length, 2);
  assert.equal(new Set([...result.assignments.map((a) => a.participantId), ...result.unassigned]).size, 3);
});

test('empty games or candidates produce sensible results', () => {
  assert.deepEqual(allocateWaitlist({ games: [], registrations: [waiting('a')], seed: 'none' }).unassigned, ['a']);
  const result = allocateWaitlist({ games: [game('a', 4, ['host'])], registrations: [], seed: 'none' });
  assert.deepEqual(result.assignments, []);
  assert.equal(result.openSeatCount, 3);
});

test('second choices take priority even when their table already has more attendees', () => {
  const input = {
    games: [game('small', 4, ['hs']), game('preferred', 4, ['hp', 'p1', 'p2'])],
    registrations: [{ ...waiting('choice'), secondaryGameId: 'preferred' }, waiting('other')], seed: 'priority',
  };
  const original = structuredClone(input);
  const result = allocateWaitlist(input);
  assert.deepEqual(result.assignments, [
    { participantId: 'choice', gameId: 'preferred', reason: 'balanced' },
    { participantId: 'other', gameId: 'small', reason: 'balanced' },
  ]);
  assert.deepEqual(input, original);
  assert.equal(result.openSeatCount, 4);
});

test('all tables finish second-choice allocation before any remaining players are balanced', () => {
  const result = allocateWaitlist({
    games: [game('a', 2, ['ha']), game('b', 2, ['hb']), game('c', 3, ['hc'])],
    registrations: [waiting('ordinary'), { ...waiting('b-choice'), secondaryGameId: 'b' }, { ...waiting('a-choice'), secondaryGameId: 'a' }],
    seed: 'all-choices-first',
  });
  assert.deepEqual(result.assignments.map((a) => [a.participantId, a.gameId]), [
    ['a-choice', 'a'], ['b-choice', 'b'], ['ordinary', 'c'],
  ]);
});

test('oversubscribed second choices use a reproducible lottery and losers enter the remaining allocation', () => {
  const winners = new Set<string>();
  for (let run = 0; run < 40; run++) {
    const input = {
      games: [game('preferred', 2, ['hp']), game('fallback', 3, ['hf'])],
      registrations: ['a', 'b', 'c'].map((id) => ({ ...waiting(id), secondaryGameId: 'preferred' })), seed: String(run),
    };
    const result = allocateWaitlist(input);
    assert.deepEqual(result, allocateWaitlist(input));
    winners.add(result.assignments[0]!.participantId);
    assert.equal(result.assignments[0]!.gameId, 'preferred');
    assert.deepEqual(result.assignments.slice(1).map((a) => a.gameId), ['fallback', 'fallback']);
    assert.equal(new Set(result.assignments.map((a) => a.participantId)).size, 3);
    assert.deepEqual(result.unassigned, []);
  }
  assert.equal(winners.size, 3);
});

test('full or unavailable second choices fall back and seated players never participate', () => {
  const result = allocateWaitlist({
    games: [game('full', 1, ['seated']), game('open', 4, ['host'])],
    registrations: [
      { participantId: 'seated', status: 'attendee', secondaryGameId: 'open' },
      { ...waiting('full-choice'), secondaryGameId: 'full' },
      { ...waiting('deleted-choice'), secondaryGameId: 'missing' },
      { ...waiting('no-choice'), secondaryGameId: null },
    ], seed: 'fallbacks',
  });
  assert.equal(result.assignments.length, 3);
  assert.ok(result.assignments.every((a) => a.gameId === 'open' && a.participantId !== 'seated'));
  assert.deepEqual(result.gameState[0]!.attendeeParticipantIds, ['seated']);
});

test('second-choice overflow conserves every player once without exceeding capacity across seeds', () => {
  for (let run = 0; run < 100; run++) {
    const registrations = Array.from({ length: 12 }, (_, i) => ({
      ...waiting(`w${i}`), secondaryGameId: [null, 'a', 'b', 'full'][i % 4],
    }));
    const result = allocateWaitlist({ games: [game('a', 3, ['ha']), game('b', 4, ['hb']), game('full', 1, ['hf'])], registrations, seed: String(run) });
    const resolved = [...result.assignments.map((a) => a.participantId), ...result.unassigned];
    assert.equal(result.assignments.length, 5);
    assert.equal(result.unassigned.length, 7);
    assert.deepEqual([...resolved].sort(), registrations.map((r) => r.participantId).sort());
    assert.equal(new Set(resolved).size, registrations.length);
    for (const table of result.gameState) assert.ok(table.attendeeParticipantIds.length <= table.capacity);
  }
});

test('100 different inputs preserve capacity, uniqueness, conservation, and fewest-attendees ordering', () => {
  for (let run = 0; run < 100; run++) {
    const games = [game('a', 4 + run % 4, Array.from({ length: 1 + run % 3 }, (_, i) => `a${i}`)), game('b', 3 + run % 3, Array.from({ length: 1 + run % 2 }, (_, i) => `b${i}`)), game('c', 4 + run % 2, Array.from({ length: 2 + run % 2 }, (_, i) => `c${i}`))];
    const registrations = Array.from({ length: 12 }, (_, i) => waiting(`w${i}`));
    const input = { games, registrations, seed: String(run) };
    const result = allocateWaitlist(input);
    assert.deepEqual(result, allocateWaitlist(input));
    const counts = new Map(games.map((g) => [g.id, g.attendees.length]));
    for (const assignment of result.assignments) {
      const current = counts.get(assignment.gameId)!;
      for (const other of games) if (counts.get(other.id)! < other.capacity) assert.ok(current <= counts.get(other.id)!);
      counts.set(assignment.gameId, current + 1);
    }
    const resolved = [...result.assignments.map((a) => a.participantId), ...result.unassigned];
    assert.equal(resolved.length, registrations.length);
    assert.equal(new Set(resolved).size, registrations.length);
    for (const state of result.gameState) {
      assert.ok(state.attendeeParticipantIds.length <= state.capacity);
      assert.equal(new Set(state.attendeeParticipantIds).size, state.attendeeParticipantIds.length);
    }
  }
});

test('names accept Chinese/WeChat names, normalize width, and reject empty/control/long values', () => {
  assert.equal(validateName('  小王 Ａ  '), '小王 A');
  assert.equal(validateName('玩家 🎲'), '玩家 🎲');
  for (const value of ['', '  ', 'a\nb', 'a\0b', '名'.repeat(41), 123, {}]) assert.throws(() => validateName(value), AppError);
});

test('event start must be strictly more than 24 hours in the future', () => {
  assert.throws(() => validateEvent(event(new Date(NOW + DAY).toISOString()), { now: NOW }), /24 小时/);
  const data = validateEvent(event(new Date(NOW + DAY + 1).toISOString()), { now: NOW });
  assert.equal(Date.parse(data.registrationClosesAt), NOW + 1);
});

test('event validation checks duration, valid dates, explicit zone, and IANA zone', () => {
  assert.throws(() => validateEvent(event('2026-11-10T18:00:00', '2026-11-10T22:00:00Z'), { now: NOW }), /时区/);
  assert.throws(() => validateEvent(event('2027-02-30T18:00:00Z', '2027-03-03T18:00:00Z'), { now: NOW }), /日期/);
  assert.throws(() => validateEvent(event('2026-11-10T18:00:00Z', '2026-11-10T18:00:00Z'), { now: NOW }), /晚于/);
  assert.throws(() => validateEvent(event('2026-11-10T18:00:00Z', '2026-11-14T18:00:00Z'), { now: NOW }), /3 天/);
  assert.throws(() => validateEvent({ ...event(), timeZone: 'MadeUp/Zone' }, { now: NOW }), /IANA/);
  assert.throws(() => validateEvent({ ...event(), location: '<x>'.repeat(34) }, { now: NOW }), /100/);
});

test('finalized event times can be corrected without a future-start requirement', () => {
  const data = validateEvent(event('2026-11-08T18:00:00Z', '2026-11-08T22:00:00Z'), { now: NOW, requireFutureStart: false });
  assert.equal(data.startAt, '2026-11-08T18:00:00.000Z');
});

test('24-hour deadline uses elapsed time across daylight saving changes', () => {
  const data = validateEvent(event('2027-03-14T19:00:00-05:00', '2027-03-14T23:00:00-05:00'), { now: NOW });
  assert.equal(Date.parse(data.startAt) - Date.parse(data.registrationClosesAt), DAY);
  assert.equal(data.registrationClosesAt, '2027-03-14T00:00:00.000Z');
});

test('game validation allows capacities 1–100 including host and rejects malformed input', () => {
  assert.deepEqual(validateGame({ name: '  卡坦岛  ', capacity: '4' }), { name: '卡坦岛', capacity: 4, description: '', difficulty: '' });
  assert.equal(validateGame({ name: 'solo', capacity: 1 }).capacity, 1);
  assert.equal(validateGame({ name: 'party', capacity: 100 }).capacity, 100);
  for (const capacity of [0, 101, 1.2, true, null, {}, '']) assert.throws(() => validateGame({ name: 'game', capacity }), AppError);
  assert.throws(() => validateGame({ name: '', capacity: 4 }), /桌游名称/);
  assert.throws(() => validateGame({ name: 'game', capacity: 4, description: 'x'.repeat(501) }), /500/);
});
