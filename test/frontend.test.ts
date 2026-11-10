import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function page(status = 'waitlist', hasAlternatives = true, isMutable = true) {
  const player = { id: 'player', displayName: '候补玩家' };
  const registration = {
    participantId: player.id, displayName: player.displayName, primaryGameId: 'primary',
    secondaryGameId: null as string | null, finalGameId: null, status, isHost: false,
  };
  const table = (id: string, name: string, capacity: number) => ({
    id, name, capacity, hostId: `${id}-host`, hostName: 'Host', isHost: false,
    attendees: [{ participantId: `${id}-host`, displayName: 'Host', isHost: true }], waitlist: [] as any[],
  });
  const primary = table('primary', '第一选择', 1);
  primary.waitlist.push({ participantId: player.id, displayName: player.displayName, rank: 1 });
  const view = {
    event: { title: '前端测试', location: '测试', timeZone: 'America/Chicago', role: 'member', canManage: false,
      status: isMutable ? 'open' : 'finalized', isMutable,
      startAt: '2027-01-16T19:00:00Z', endAt: '2027-01-16T23:00:00Z', registrationClosesAt: '2027-01-15T19:00:00Z' },
    participant: player, registration, games: [primary, ...(hasAlternatives ? [
      table('full', '满员桌 <朋友>', 1), table('open', '空位桌', 4),
    ] : [])], members: [], unassigned: [], testToolsEnabled: false,
  };
  const listeners: Record<string, (event: any) => void> = {};
  const classList = { add() {}, remove() {}, toggle() {} };
  const root = { innerHTML: '', classList, setAttribute() {}, querySelectorAll: () => [],
    addEventListener: (type: string, listener: (event: any) => void) => { listeners[type] = listener; } };
  const notice = { textContent: '', hidden: true, classList, scrollIntoView() {} };
  const writes: Array<{ path: string; method: string; body: any }> = [];
  const context = createContext({
    document: { querySelector: (selector: string) => selector === '#app' ? root : selector === '#notice' ? notice : null, title: '' },
    window: { addEventListener() {}, scrollTo() {} }, location: { pathname: '/events/ABCD2345', origin: 'http://localhost:3000' },
    sessionStorage: { getItem: () => null },
    FormData: class {
      constructor(private form: { values: Record<string, string> }) {}
      [Symbol.iterator]() { return Object.entries(this.form.values)[Symbol.iterator](); }
    },
    fetch: async (path: string, options: { method: string; body?: string }) => {
      if (options.method === 'PATCH') {
        const body = JSON.parse(options.body!);
        writes.push({ path, method: options.method, body });
        registration.secondaryGameId = body.secondaryGameId;
        return { ok: true, json: async () => ({ data: { secondaryGameId: body.secondaryGameId } }) };
      }
      return { ok: true, json: async () => ({ data: path.endsWith('/session') ? { participant: player } : view }) };
    },
  });
  runInContext(source, context);
  await settle();
  assert.ok(root.innerHTML.includes('前端测试'), 'the real page script bootstraps and renders the event');
  return { root, notice, writes, context, registration, listeners };
}

test('the waitlist UI saves full and open second choices without changing rendered table counts or rosters', async () => {
  const p = await page();
  assert.ok(p.root.innerHTML.includes('第二选择（可选，仅你可见）'));
  assert.ok(p.root.innerHTML.includes('满员桌 &lt;朋友&gt;（已满员，仍可选择）'));
  const statusHtml = runInContext('renderMyStatus()', p.context) as string;
  assert.ok(!statusHtml.includes('<option value="primary"'), 'the primary table is excluded');
  const tablesBefore = runInContext('state.details.games.map(renderGame).join("")', p.context);
  for (const id of ['full', 'open']) {
    const form = { dataset: { form: 'second-choice' }, values: { secondaryGameId: id } };
    p.listeners.submit!({ target: { closest: () => form }, preventDefault() {} });
    await settle();
    assert.deepEqual(p.writes.at(-1), { path: '/api/v1/events/ABCD2345/my-registration', method: 'PATCH', body: { secondaryGameId: id } });
    assert.ok(p.root.innerHTML.includes(`<option value="${id}" selected>`));
    assert.ok(p.root.innerHTML.includes('取消第二选择'));
    assert.equal(p.registration.status, 'waitlist');
    assert.equal(runInContext('state.details.games.map(renderGame).join("")', p.context), tablesBefore);
  }
});

test('both the cancel button and empty selection send null and clear the saved second choice', async () => {
  const p = await page();
  p.registration.secondaryGameId = 'full';
  p.listeners.click!({ target: { closest: () => ({ dataset: { action: 'clear-second-choice' } }) }, preventDefault() {} });
  await settle();
  assert.deepEqual(p.writes.at(-1)?.body, { secondaryGameId: null });
  assert.ok(!p.root.innerHTML.includes('data-action="clear-second-choice"'));
  assert.equal(p.notice.textContent, '已取消第二选择。');
  p.registration.secondaryGameId = 'open';
  p.listeners.submit!({ target: { closest: () => ({ dataset: { form: 'second-choice' }, values: { secondaryGameId: '' } }) }, preventDefault() {} });
  await settle();
  assert.deepEqual(p.writes.at(-1)?.body, { secondaryGameId: null });
  assert.equal(p.registration.secondaryGameId, null);
});

test('second-choice controls are disabled without another table and absent for seated or finalized players', async () => {
  const alone = await page('waitlist', false);
  assert.ok(alone.root.innerHTML.includes('name="secondaryGameId" disabled'));
  assert.ok(alone.root.innerHTML.includes('目前没有其他桌游可作为第二选择。'));
  for (const p of [await page('attendee'), await page('waitlist', true, false)]) {
    assert.ok(!p.root.innerHTML.includes('data-form="second-choice"'));
  }
});
