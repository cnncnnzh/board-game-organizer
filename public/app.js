'use strict';

const root = document.querySelector('#app');
const notice = document.querySelector('#notice');
const state = { participant: null, browserParticipant: null, code: '', details: null, preview: null, secret: null, busy: false, expandedGames: new Set(), testToolsOpen: true, testGameId: '' };
const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const roleLabel = (role) => ({ owner: '组织者', admin: '管理员', member: '成员' }[role] || '成员');

async function api(path, method = 'GET', body) {
  const options = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`/api/v1${path}`, options);
  let result;
  try { result = await response.json(); } catch { throw new Error('服务暂时不可用，请稍后重试。'); }
  if (!response.ok || result.error) throw new Error(result.error?.message || '操作失败，请重试。');
  return result.data;
}

function message(text, error = false) {
  notice.textContent = text;
  notice.classList.toggle('error', error);
  notice.hidden = !text;
  if (text) notice.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function getZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';
}

function dateParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function dateInput(value, timeZone = getZone()) {
  const p = dateParts(value, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function dateText(value, timeZone) {
  if (!value) return '待定';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: timeZone || getZone(), month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

function localToISO(value, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('请填写完整的日期和时间。');
  const [year, month, day, hour, minute] = value.match(/\d+/g).map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let result = desired;
  for (let index = 0; index < 4; index += 1) {
    const p = dateParts(result, timeZone);
    const displayed = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    const adjustment = desired - displayed;
    result += adjustment;
    if (!adjustment) break;
  }
  if (dateInput(result, timeZone) !== value) throw new Error('该时区的这个时间不存在（可能处于夏令时切换），请选择其他时间。');
  return new Date(result).toISOString();
}

function eventFields(event = {}) {
  const zone = event.timeZone || getZone();
  const start = event.startAt || Date.now() + 48 * 60 * 60 * 1000;
  const end = event.endAt || new Date(new Date(start).getTime() + 4 * 60 * 60 * 1000).toISOString();
  return `<label class="field">活动名称<input name="title" maxlength="40" value="${esc(event.title || '周末桌游局')}" required></label>
    <label class="field">活动地点<input name="location" maxlength="100" placeholder="例如：朋友家 / 桌游店名称" value="${esc(event.location)}" required></label>
    <div class="field-row"><label class="field">开始时间<input name="startAt" type="datetime-local" value="${esc(dateInput(start, zone))}" required></label><label class="field">结束时间<input name="endAt" type="datetime-local" value="${esc(dateInput(end, zone))}" required></label></div>
    <label class="field">活动时区<input name="timeZone" value="${esc(zone)}" maxlength="100" required><small>日期和时间按此时区解释，例如 America/Chicago、Asia/Shanghai。</small></label>`;
}

function gameFields(game = {}) {
  const options = ['', '入门', '中等', '进阶', '硬核'];
  if (game.difficulty && !options.includes(game.difficulty)) options.push(game.difficulty);
  return `<label class="field">桌游名称<input name="name" maxlength="50" value="${esc(game.name)}" placeholder="例如：卡坦岛" required></label>
    <div class="field-row"><label class="field">人数上限（包含 Host）<input name="capacity" type="number" min="1" max="100" value="${esc(game.capacity || 4)}" required></label><label class="field">难度<select name="difficulty">${options.map((v) => `<option value="${esc(v)}" ${v === (game.difficulty || '') ? 'selected' : ''}>${esc(v || '不设置')}</option>`).join('')}</select></label></div>
    <label class="field">简介（可选）<textarea name="description" maxlength="500" placeholder="规则、预计时长，或想告诉玩家的话">${esc(game.description)}</textarea></label>`;
}

function renderHome() {
  document.title = '创建桌游活动 · 桌游一起玩';
  root.innerHTML = `<div class="home-grid">
    <section class="intro"><p class="eyebrow">Good games. Great company.</p><h1>凑一桌，<br>一起开玩。</h1><p>把想玩的桌游和朋友聚在一起。创建活动、分享链接，剩下的报名和候补交给这里。</p>
      <ol class="how-it-works"><li><span class="step-number">1</span>创建活动，拿到专属链接和活动码</li><li><span class="step-number">2</span>朋友填写名字，选择想玩的桌游</li><li><span class="step-number">3</span>满员自动候补，截止后自动均衡分桌</li></ol>
      <section class="panel join-panel"><h2>已经有朋友组局？</h2><form data-form="resolve" class="inline-form"><label class="field">输入活动码<input class="join-code" name="code" autocomplete="off" autocapitalize="characters" maxlength="16" placeholder="活动码" required></label><button class="button button-yellow" type="submit">进入活动 →</button></form></section>
    </section>
    <section class="panel create-panel"><p class="eyebrow">Start your next game night</p><h2>创建桌游活动</h2><form data-form="create-event" class="form-stack"><label class="field">你的姓名或微信名<input name="displayName" autocomplete="nickname" maxlength="40" value="${esc(state.participant?.displayName)}" placeholder="让朋友知道是谁组的局" required></label>${eventFields()}<p class="help">无需注册。活动开始前 24 小时自动截止报名，因此开始时间需要在 24 小时之后；活动最长 3 天。</p><button class="button button-primary button-block" type="submit">创建活动，邀请朋友 →</button></form></section>
  </div>`;
}

function names(items, waitlist = false) {
  if (!items?.length) return `<p class="tiny muted">${waitlist ? '暂无候补' : '暂无成员'}</p>`;
  return `<ul class="name-list ${waitlist ? 'waitlist' : ''}">${items.map((member, i) => `<li>${waitlist ? `${esc(member.rank || i + 1)}. ` : ''}${esc(member.displayName)}${member.isHost ? ' · Host' : ''}</li>`).join('')}</ul>`;
}

function mutable() {
  return state.details?.event.status === 'open' && new Date(state.details.event.registrationClosesAt).getTime() > Date.now();
}

function renderGame(game) {
  const open = mutable();
  const mine = state.details.registration;
  const isHost = game.isHost || game.hostId === state.participant?.id;
  const expanded = state.expandedGames.has(game.id);
  return `<article class="game-card"><div class="game-header"><div><h3>${esc(game.name)}</h3>${game.difficulty ? `<span class="game-difficulty">${esc(game.difficulty)}</span>` : ''}</div><button type="button" class="seat-count" data-action="toggle-roster" data-id="${esc(game.id)}" aria-expanded="${expanded}" aria-controls="game-roster-${esc(game.id)}" aria-label="${esc(game.name)}：${game.attendees?.length || 0} / ${esc(game.capacity)} 人，Host 和参与者"><span class="seat-chevron" aria-hidden="true">&gt;</span><span>${game.attendees?.length || 0}<span class="muted"> / ${esc(game.capacity)}</span></span></button></div>
    <div id="game-roster-${esc(game.id)}" class="game-roster"${expanded ? '' : ' hidden'}>
      <p class="game-host">Host · ${esc(game.hostName || '—')}</p>
      <div><span class="member-label">已入席${isHost ? ' · 你是 Host' : ''}</span>${names(game.attendees)}</div>
      ${game.waitlist?.length ? `<div><span class="member-label">候补 · ${game.waitlist.length} 人</span>${names(game.waitlist, true)}</div>` : ''}
    </div>
    ${game.description ? `<p class="game-description">${esc(game.description)}</p>` : ''}
    ${open ? `<div class="game-actions">${!mine ? `<button class="button ${(game.attendees?.length || 0) < game.capacity ? 'button-primary' : 'button-secondary'} button-block" data-action="join" data-id="${esc(game.id)}">${(game.attendees?.length || 0) < game.capacity ? '报名这桌' : '加入候补'}</button>` : `<span class="badge ${mine.primaryGameId === game.id ? '' : 'badge-closed'}">${mine.primaryGameId === game.id ? (mine.isHost ? '我主持的桌' : mine.status === 'waitlist' ? '我正在候补' : '我报名的桌') : '退出当前报名后可换桌'}</span>`}
    ${isHost ? `<details><summary>编辑我的桌游</summary><form data-form="edit-game" data-id="${esc(game.id)}" class="form-stack">${gameFields(game)}<div class="button-row"><button class="button button-secondary" type="submit">保存桌游</button><button class="button button-danger" type="button" data-action="delete-game" data-id="${esc(game.id)}">删除这桌</button></div></form></details>` : ''}</div>` : ''}
  </article>`;
}

function renderIdentity() {
  const form = `<form data-form="identity" class="inline-form"><label class="field">姓名或微信名<input id="identity-name" name="displayName" autocomplete="nickname" maxlength="40" value="${esc(state.participant?.displayName || state.browserParticipant?.displayName)}" placeholder="朋友认识的名字" required></label><button class="button button-secondary" type="submit">${state.participant ? '保存姓名' : '保存名字，开始报名'}</button></form><p class="help">无需登录。此浏览器会记住你的报名凭证；换浏览器或清除 Cookie 后，输入同名不能恢复原报名。活动中若已有人使用同名，请加一个可辨认的后缀。</p>`;
  return `<section class="panel identity-panel"><h2>${state.participant ? `你好，${esc(state.participant.displayName)}` : '填写名字，加入这场活动'}</h2>${state.participant ? `<details class="identity-editor"><summary class="button button-secondary">更新姓名</summary>${form}</details>` : form}</section>`;
}

function renderMyStatus() {
  const registration = state.details.registration;
  if (!registration) return '';
  const destination = registration.finalGameId || registration.primaryGameId;
  const game = state.details.games.find((item) => item.id === destination);
  let text = registration.isHost ? `你是「${game?.name || '桌游'}」的 Host，已计入人数。` : `你已入席「${game?.name || '桌游'}」。`;
  if (registration.status === 'waitlist') {
    const wait = game?.waitlist?.find((member) => member.participantId === state.participant?.id);
    text = `你正在「${game?.name || '桌游'}」候补${wait?.rank ? `，排第 ${wait.rank} 位` : ''}。有人退出会自动晋级；截止后候补可能分配到其他桌。`;
  }
  if (registration.status === 'unassigned') text = '本次活动已完成分桌，很遗憾没有足够空位，你暂未分配到桌游。';
  return `<section class="status-panel"><p>${esc(text)}</p>${mutable() ? (registration.isHost ? '<p class="help">Host 退出需删除自己创建的桌游，该桌所有报名会一并解除。</p>' : '<div class="button-row"><button class="button button-secondary button-small" data-action="drop">退出当前报名</button></div>') : ''}</section>`;
}

function renderManager() {
  const { event, members = [] } = state.details;
  const owner = event.role === 'owner';
  if (!event.canManage && !owner && event.role !== 'admin') return '';
  return `<section class="panel organizer-panel"><details><summary>活动管理 · ${roleLabel(event.role)}</summary><form data-form="edit-event" class="form-stack">${eventFields(event)}<p class="help">${event.status === 'finalized' ? '分桌结果已固定；修改活动信息不会重新开放报名或重新分桌。' : '修改开始时间也会更新报名截止时间。'}</p><div class="button-row"><button class="button button-secondary" type="submit">保存活动信息</button>${mutable() ? '<button class="button button-danger" type="button" data-action="delete-event">删除整个活动</button>' : ''}</div></form>
    ${owner ? `<hr class="divider"><h3>成员与管理权限</h3><p class="help">管理员可以管理活动信息。转让组织者后，你会变为管理员。</p><div class="member-table-wrap"><table class="member-table"><thead><tr><th>成员</th><th>角色</th><th>操作</th></tr></thead><tbody>${members.filter((member) => !member.isTest).map((member) => `<tr><td>${esc(member.displayName)}</td><td>${roleLabel(member.role)}</td><td>${member.role !== 'owner' ? `<div class="button-row"><button class="button button-secondary button-small" data-action="toggle-admin" data-id="${esc(member.id)}" data-value="${member.role !== 'admin'}">${member.role === 'admin' ? '撤销管理员' : '设为管理员'}</button><button class="button button-danger button-small" data-action="transfer-owner" data-id="${esc(member.id)}">转让组织者</button></div>` : '当前组织者'}</td></tr>`).join('')}</tbody></table></div><hr class="divider"><h3>组织者恢复密钥</h3><p class="help">需要更换密钥时可重新生成。旧密钥及通过旧密钥恢复的授权会立即失效。</p><button class="button button-secondary button-small" data-action="rotate-key">重新生成恢复密钥</button>` : ''}</details></section>`;
}

function renderTestTools() {
  if (!state.details.testToolsEnabled || state.details.event.role !== 'owner') return '';
  const testUsers = (state.details.members || []).filter((member) => member.isTest);
  const games = state.details.games;
  const testPlayers = testUsers.filter((member) => !games.some((game) => game.hostId === member.id));
  const open = mutable();
  return `<section class="panel test-panel"><details id="test-tools" ${state.testToolsOpen ? 'open' : ''}><summary>测试工具（仅测试环境）· ${testUsers.length} 个测试身份</summary>
    ${open ? `<p class="help">先创建测试桌游和 Host，再为指定桌游批量加人。满员后自动候补，每个活动最多 50 个测试身份（包含 Host）。</p>
      <div class="test-columns">
        <form data-form="test-game" class="form-stack"><h3>1. 创建测试桌游</h3><label class="field">测试桌游名称<input name="name" maxlength="50" value="测试桌游" required></label><label class="field">人数上限（包含 Host）<input name="capacity" type="number" min="1" max="100" value="4" required></label><p class="help">自动创建独立测试 Host，占用一个席位。</p><button class="button button-secondary" type="submit">创建测试桌游和 Host</button></form>
        <form data-form="test-game-users" class="form-stack"><h3>2. 给指定桌游添加玩家</h3><label class="field">目标桌游<select name="gameId" required ${games.length ? '' : 'disabled'}><option value="">选择桌游</option>${games.map((game) => `<option value="${esc(game.id)}" ${game.id === state.testGameId ? 'selected' : ''}>${esc(game.name)} · ${game.attendees.length}/${esc(game.capacity)} 人 · ${game.waitlist.length} 人候补</option>`).join('')}</select></label><label class="field">新增测试玩家数（1–30 人）<input name="count" type="number" min="1" max="30" value="5" required></label><p class="help">${games.length ? '新玩家会直接报名所选桌游，超出容量的人进入候补。' : '请先创建至少一个桌游。'}</p><button class="button button-secondary" type="submit" ${games.length ? '' : 'disabled'}>创建玩家并报名这桌</button></form>
      </div>
      <h3>3. 分配并查看结果</h3><p class="help">一键分配会立即截止本活动，保存正式结果并冻结报名；想继续调整数据时，可先仅预览。</p><div class="button-row"><button class="button button-yellow" data-action="test-finalize" ${games.length ? '' : 'disabled'}>一键截止并分配，查看结果</button><button class="button button-secondary" data-action="preview" ${games.length ? '' : 'disabled'}>仅预览（不截止）</button></div>
      <details><summary>更多测试操作</summary><form data-form="test-users" class="inline-form"><label class="field">仅创建测试玩家（暂不报名，1–30 人）<input name="count" type="number" min="1" max="30" value="10" required></label><button class="button button-secondary" type="submit">创建测试玩家</button></form><div class="button-row"><button class="button button-secondary" data-action="test-reuse">复用上次测试用户</button><button class="button button-secondary" data-action="test-fill">均匀报名测试玩家</button></div>
        ${testPlayers.length ? `<div class="member-table-wrap"><table class="member-table test-table"><thead><tr><th>测试玩家</th><th>模拟操作</th></tr></thead><tbody>${testPlayers.map((member) => `<tr><td>${esc(member.displayName)}</td><td><form data-form="test-join" data-id="${esc(member.id)}" class="button-row"><select name="gameId" aria-label="${esc(member.displayName)}要报名的桌游" required><option value="">选择桌游</option>${games.map((game) => `<option value="${esc(game.id)}">${esc(game.name)}</option>`).join('')}</select><button class="button button-secondary button-small" type="submit">报名</button><button class="button button-secondary button-small" type="button" data-action="test-drop" data-id="${esc(member.id)}">退出</button></form></td></tr>`).join('')}</tbody></table></div>` : ''}
      </details><div id="allocation-preview">${renderPreview()}</div>` : '<p class="help">本活动已截止。最终分配结果在上方展示；如需重新测试，可清除活动并创建新活动，测试身份可复用。</p>'}
    <hr class="divider"><div class="button-row"><button class="button button-danger" data-action="clear-test-users">清理测试用户与关联报名</button><button class="button button-danger" data-action="clear-test-event">清除活动，保留测试用户</button></div>
    </details></section>`;
}

function renderPreview() {
  if (!state.preview) return '';
  const p = state.preview;
  return `<div class="preview-panel"><h3>分配预览</h3><p class="help">基于当前数据；之后的报名变化可能改变正式结果。</p>${(p.games || []).map((game) => `<h3>${esc(game.name)} · ${(game.attendees || []).length}/${esc(game.capacity)}</h3>${names(game.attendees)}`).join('')}<h3>未分配</h3>${names(p.unassigned)}</div>`;
}

function managementKey() {
  if (state.secret?.code === state.code) return state.secret.key;
  try { return sessionStorage.getItem(`organizer-key:${state.code}`) || ''; } catch { return ''; }
}

function renderEvent() {
  const { event, games = [], unassigned = [] } = state.details;
  const closed = !mutable();
  document.title = `${event.title} · 桌游一起玩`;
  const key = managementKey();
  root.innerHTML = `<div class="event-head"><h1>${esc(event.title)}</h1><p class="event-meta"><span>地点 · ${esc(event.location)}</span><span>${esc(dateText(event.startAt, event.timeZone))} — ${esc(dateText(event.endAt, event.timeZone))}</span><span>${esc(event.timeZone || getZone())}</span></p></div>
    <div class="event-tools"><div><span class="badge ${closed ? 'badge-closed' : ''}">${event.status === 'finalized' ? '分桌完成' : closed ? '报名已截止' : '正在报名'}</span> <span class="tiny muted">${closed ? '报名截止' : '报名截至'} ${esc(dateText(event.registrationClosesAt, event.timeZone))}</span></div><div class="button-row"><button class="button button-secondary button-small" data-action="copy-link">复制邀请链接</button><button class="button button-secondary button-small" data-action="copy-code">复制活动码</button><button class="button button-secondary button-small" data-action="refresh">刷新</button></div></div>
    ${key ? `<section class="secret-panel"><h2>请保存你的组织者恢复密钥</h2><p>当前浏览器已拥有管理权限。换浏览器时可用此密钥恢复管理，请单独保存，只分享给可信任的组织者。</p><code class="secret-key">${esc(key)}</code><div class="button-row"><button class="button button-yellow button-small" data-action="copy-key">复制恢复密钥</button><button class="button button-secondary button-small" data-action="hide-key">已保存，隐藏密钥</button></div></section>` : ''}
    ${renderIdentity()}${renderMyStatus()}
    ${event.status === 'finalized' && event.result ? `<div class="result-summary"><span class="result-stat"><strong>${esc(event.result.attendeeCount ?? games.reduce((n, game) => n + (game.attendees?.length || 0), 0))}</strong>人入席</span><span class="result-stat"><strong>${esc(event.result.assignedFromWaitlist || 0)}</strong>人从候补分配</span><span class="result-stat"><strong>${esc(event.result.unassignedCount || 0)}</strong>人未分配</span></div>` : ''}
    <div class="section-top"><h2>${event.status === 'finalized' ? '最终桌游分配' : '这次玩什么'} <span class="badge">${games.length} 桌</span></h2></div><p class="section-note">${event.status === 'finalized' ? '名单已固定。活动结束 24 小时后，本活动及报名数据将自动删除。' : '每人只能选择一桌，人数包含 Host。候补会在有空位时自动晋级。'}</p>
    ${games.length ? `<div class="game-grid">${games.map(renderGame).join('')}</div>` : '<div class="empty">还没有桌游。带上一款喜欢的游戏，来当第一位 Host 吧。</div>'}
    ${mutable() && !state.details.registration ? `<details class="panel create-game"><summary>我来开一桌</summary><form data-form="create-game" class="form-stack">${gameFields()}<p class="help">创建后你会自动成为 Host 并占一个席位。每人只能报名或主持一桌。</p><button class="button button-primary" type="submit">创建桌游，成为 Host</button></form></details>` : ''}
    ${event.status === 'finalized' && unassigned.length ? `<section class="panel unassigned"><h2>暂未分配到桌游</h2>${names(unassigned)}</section>` : ''}
    ${renderManager()}${renderTestTools()}
    <section class="panel recovery-panel"><details><summary>在新浏览器恢复组织者权限</summary><form data-form="recover" class="form-stack"><label class="field">组织者恢复密钥<input name="managementKey" type="password" autocomplete="off" required></label><button class="button button-secondary" type="submit">恢复管理权限</button></form><p class="help">普通报名者无需此密钥。恢复组织者权限不能通过输入同名实现。</p></details></section>`;
}

async function loadRoute() {
  const match = location.pathname.match(/^\/events\/([^/]+)\/?$/);
  state.code = match ? decodeURIComponent(match[1]).toUpperCase() : '';
  state.expandedGames.clear();
  state.testToolsOpen = true;
  state.testGameId = '';
  root.setAttribute('aria-busy', 'true');
  try {
    const session = await api('/session');
    state.browserParticipant = session.participant;
    state.participant = session.participant;
    if (state.code) {
      state.details = await api(`/events/${encodeURIComponent(state.code)}`);
      if ('participant' in state.details) state.participant = state.details.participant;
      renderEvent();
    } else renderHome();
  } catch (error) {
    root.innerHTML = `<section class="panel page-error"><p class="eyebrow">Let’s find your table</p><h1>暂时无法打开活动</h1><p>${esc(error.message)}</p><p class="help">请核对活动码。活动可能已删除，或已在结束 24 小时后自动清理。</p><a class="button button-primary" href="/">返回首页</a></section>`;
  } finally {
    root.setAttribute('aria-busy', 'false');
  }
}

async function refresh({ expandGames = false } = {}) {
  const session = await api('/session');
  state.browserParticipant = session.participant;
  state.details = await api(`/events/${encodeURIComponent(state.code)}`);
  state.participant = 'participant' in state.details ? state.details.participant : session.participant;
  state.preview = null;
  if (expandGames) state.details.games.forEach((game) => state.expandedGames.add(game.id));
  renderEvent();
}

async function ensureMember() {
  if (!state.participant) {
    document.querySelector('#identity-name')?.focus();
    throw new Error('请先填写并保存你的姓名或微信名。');
  }
  await api(`/events/${state.code}/members`, 'POST', { displayName: state.participant.displayName });
}

async function run(callback) {
  if (state.busy) return;
  state.busy = true;
  root.classList.add('busy');
  root.setAttribute('aria-busy', 'true');
  const buttons = [...root.querySelectorAll('button')];
  const enabledButtons = buttons.filter((button) => !button.disabled);
  enabledButtons.forEach((button) => { button.disabled = true; });
  message('');
  try { await callback(); } catch (error) { message(error.message || '操作失败，请重试。', true); }
  finally {
    state.busy = false;
    root.classList.remove('busy');
    root.setAttribute('aria-busy', 'false');
    enabledButtons.forEach((button) => { button.disabled = false; });
  }
}

async function navigate(code) {
  history.pushState({}, '', `/events/${encodeURIComponent(code)}`);
  state.preview = null;
  await loadRoute();
  window.scrollTo({ top: 0 });
}

function eventPayload(form) {
  const values = Object.fromEntries(new FormData(form));
  values.startAt = localToISO(values.startAt, values.timeZone);
  values.endAt = localToISO(values.endAt, values.timeZone);
  return values;
}

root.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  void run(async () => {
    const kind = form.dataset.form;
    const values = Object.fromEntries(new FormData(form));
    if (kind === 'create-event') {
      const result = await api('/events', 'POST', eventPayload(form));
      const code = result.event.code;
      try { sessionStorage.setItem(`organizer-key:${code}`, result.managementKey); } catch { /* The key is still shown below if storage is unavailable. */ }
      await navigate(code);
      if (!managementKey() && result.managementKey) {
        const panel = document.createElement('section');
        panel.className = 'secret-panel';
        panel.innerHTML = `<h2>请保存组织者恢复密钥</h2><p>换浏览器时使用此密钥恢复管理权限。仅向可信任的人分享。</p><code class="secret-key">${esc(result.managementKey)}</code>`;
        root.prepend(panel);
      }
      message('活动已创建。复制链接或活动码，邀请朋友来报名吧。');
      return;
    }
    if (kind === 'resolve') {
      const code = values.code.trim().replace(/[\s-]/g, '').toUpperCase();
      const result = await api(`/events/resolve/${encodeURIComponent(code)}`);
      await navigate(result.code || code);
      return;
    }
    if (kind === 'identity') {
      if (!state.browserParticipant) {
        const result = await api('/session', 'POST', values);
        state.browserParticipant = result.participant;
      }
      await api(`/events/${state.code}/members`, 'POST', values);
      await refresh();
      message('名字已保存，现在可以报名或开桌。');
      return;
    }
    if (kind === 'recover') {
      await api(`/events/${state.code}/manage`, 'POST', { ...values, displayName: state.participant?.displayName || '活动组织者' });
      await refresh();
      message('组织者权限已恢复。');
      return;
    }
    if (kind === 'create-game' || kind === 'edit-game') {
      await ensureMember();
      values.capacity = Number(values.capacity);
      await api(`/events/${state.code}/games${kind === 'edit-game' ? `/${encodeURIComponent(form.dataset.id)}` : ''}`, kind === 'edit-game' ? 'PATCH' : 'POST', values);
      await refresh();
      message(kind === 'create-game' ? '桌游已创建，你已成为 Host。' : '桌游已更新。');
      return;
    }
    if (kind === 'edit-event') {
      await api(`/events/${state.code}`, 'PATCH', eventPayload(form));
      await refresh();
      message('活动信息已保存。');
      return;
    }
    if (kind === 'test-users') {
      await api(`/events/${state.code}/test-users`, 'POST', { count: Number(values.count) });
    } else if (kind === 'test-game') {
      const result = await api(`/events/${state.code}/test-games`, 'POST', { ...values, capacity: Number(values.capacity) });
      state.testGameId = result.gameId;
    } else if (kind === 'test-game-users') {
      const result = await api(`/events/${state.code}/games/${encodeURIComponent(values.gameId)}/test-users`, 'POST', { count: Number(values.count) });
      state.testGameId = values.gameId;
      state.expandedGames.add(values.gameId);
      await refresh();
      message(`已添加 ${result.createdCount} 位测试玩家：${result.attendeeCount} 人入席，${result.waitlistCount} 人候补。`);
      return;
    } else if (kind === 'test-join') {
      await api(`/events/${state.code}/test-users/${encodeURIComponent(form.dataset.id)}/join`, 'POST', values);
    }
    await refresh();
    message('测试操作已完成。');
  });
});

async function copy(text, label) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); message(`${label}已复制。`); return; } catch { /* Fall back to selectable text. */ }
  }
  message(`请手动复制${label}：${text}`);
}

root.addEventListener('toggle', (event) => {
  if (event.target.id === 'test-tools') state.testToolsOpen = event.target.open;
}, true);

root.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  event.preventDefault();
  if (button.dataset.action === 'toggle-roster') {
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(expanded));
    document.getElementById(button.getAttribute('aria-controls')).hidden = !expanded;
    if (expanded) state.expandedGames.add(button.dataset.id);
    else state.expandedGames.delete(button.dataset.id);
    return;
  }
  void run(async () => {
    const action = button.dataset.action;
    const id = encodeURIComponent(button.dataset.id || '');
    if (action === 'copy-link') return copy(`${location.origin}/events/${state.code}`, '邀请链接');
    if (action === 'copy-code') return copy(state.code, '活动码');
    if (action === 'copy-key') return copy(managementKey(), '组织者恢复密钥');
    if (action === 'hide-key') {
      try { sessionStorage.removeItem(`organizer-key:${state.code}`); } catch { /* No storage to clear. */ }
      state.secret = null;
      renderEvent();
      return;
    }
    if (action === 'refresh') { await refresh(); message('已刷新最新报名情况。'); return; }
    if (action === 'join') {
      await ensureMember();
      const result = await api(`/events/${state.code}/games/${id}/registrations`, 'POST', {});
      await refresh();
      message(result.status === 'waitlist' ? '已进入候补，有空位时会自动晋级。' : '报名成功，已为你留好席位。');
      return;
    }
    if (action === 'drop') {
      if (!confirm('确定退出当前报名吗？空出的席位会由队首候补自动获得。')) return;
      await api(`/events/${state.code}/my-registration`, 'DELETE');
    } else if (action === 'delete-game') {
      if (!confirm('确定删除这桌吗？所有入席和候补成员都会恢复为未报名状态。')) return;
      await api(`/events/${state.code}/games/${id}`, 'DELETE');
    } else if (action === 'delete-event' || action === 'clear-test-event') {
      if (!confirm('确定永久删除整个活动、所有桌游和报名吗？此操作无法撤销。')) return;
      await api(`/events/${state.code}${action === 'clear-test-event' ? '/test-event' : ''}`, 'DELETE');
      history.pushState({}, '', '/');
      await loadRoute();
      message('活动已删除。');
      return;
    } else if (action === 'toggle-admin') {
      if (!confirm(button.dataset.value === 'true' ? '确定任命这位成员为活动管理员？' : '确定撤销这位成员的管理员权限？')) return;
      await api(`/events/${state.code}/admins/${id}`, 'PUT', { isAdmin: button.dataset.value === 'true' });
    } else if (action === 'transfer-owner') {
      if (!confirm('确定转让组织者权限？对方会成为唯一组织者，你会变为管理员。')) return;
      await api(`/events/${state.code}/owner-transfer`, 'POST', { participantId: button.dataset.id });
      try { sessionStorage.removeItem(`organizer-key:${state.code}`); } catch { /* No storage to clear. */ }
      state.secret = null;
      await refresh();
      message('已转让；请新组织者在自己的浏览器重新生成并保存恢复密钥。');
      return;
    } else if (action === 'rotate-key') {
      if (!confirm('确定重新生成恢复密钥？旧密钥和使用旧密钥恢复的管理授权会失效。')) return;
      const result = await api(`/events/${state.code}/management-key`, 'POST', {});
      state.secret = { code: state.code, key: result.managementKey };
      try { sessionStorage.setItem(`organizer-key:${state.code}`, result.managementKey); } catch { /* The key remains visible in this page. */ }
    } else if (action === 'test-fill') {
      await api(`/events/${state.code}/test-fill`, 'POST', {});
    } else if (action === 'test-reuse') {
      await api(`/events/${state.code}/test-reuse`, 'POST', {});
    } else if (action === 'test-finalize') {
      const { result } = await api(`/events/${state.code}/test-finalize`, 'POST', {});
      await refresh({ expandGames: true });
      message(`测试分配已完成：${result.attendeeCount} 人入席，${result.assignedFromWaitlist} 人从候补分配，${result.unassignedCount} 人未分配。`);
      document.querySelector('.result-summary')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    } else if (action === 'preview') {
      state.preview = await api(`/events/${state.code}/preview`, 'POST', {});
      document.querySelector('#allocation-preview').innerHTML = renderPreview();
      message('分配预览已生成，正式报名和结果没有改变。');
      return;
    } else if (action === 'clear-test-users') {
      if (!confirm('确定清理全部测试用户和关联报名？测试 Host 的桌游也会删除，真实成员账号会保留。')) return;
      await api(`/events/${state.code}/test-users`, 'DELETE');
    } else if (action === 'test-drop') {
      await api(`/events/${state.code}/test-users/${id}/drop`, 'POST', {});
    }
    await refresh();
    message('已更新。');
  });
});

window.addEventListener('popstate', () => { message(''); void loadRoute(); });
void loadRoute();
