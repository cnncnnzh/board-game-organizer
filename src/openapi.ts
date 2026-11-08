type Schema = Record<string, unknown>;
type Route = { method: string; path: string };

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const list = (items: Schema): Schema => ({ type: 'array', items });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required });
const envelope = (data: Schema): Schema => object({ data });
const text = (maxLength?: number): Schema => ({ type: 'string', ...(maxLength ? { maxLength } : {}) });
const id: Schema = { type: 'string', format: 'uuid' };
const timestamp: Schema = { type: 'string', format: 'date-time' };
const boolean: Schema = { type: 'boolean' };
const count: Schema = { type: 'integer', minimum: 0 };
const code: Schema = { type: 'string', pattern: '^[A-HJ-NP-Z2-9]{8}$', example: 'ABCD2345' };
const name: Schema = { type: 'string', minLength: 1, maxLength: 40, description: '姓名或微信名；NFKC 规范化，同一活动内不区分大小写且唯一。' };
const key: Schema = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$', description: '管理恢复秘密，生成时单次返回；不要随普通活动链接分享。' };

const eventFields: Record<string, Schema> = {
  title: { ...text(40), default: '桌游聚会' }, location: { ...text(100), minLength: 1 },
  startAt: { ...timestamp, description: '必须包含明确 UTC offset；报名期须严格晚于当前时间加 24 小时。' },
  endAt: { ...timestamp, description: '晚于开始时间，活动最长 3 天。' },
  timeZone: { ...text(100), default: 'America/Chicago', example: 'America/Chicago' },
};
const gameFields: Record<string, Schema> = {
  name: { ...text(50), minLength: 1 }, capacity: { type: 'integer', minimum: 1, maximum: 100, description: '包含 host。' },
  description: text(500), difficulty: text(20),
};

const schemas: Record<string, Schema> = {
  Participant: object({ id, displayName: name }),
  Member: object({ id, displayName: name, role: { type: 'string', enum: ['member', 'admin', 'owner'] }, isTest: boolean }),
  Result: object({ gameCount: count, attendeeCount: count, assignedFromWaitlist: count, unassignedCount: count }),
  Event: object({
    id, code, title: text(40), location: text(100), startAt: timestamp, endAt: timestamp, timeZone: text(100),
    registrationClosesAt: timestamp, status: { type: 'string', enum: ['open', 'finalized'] },
    finalizedAt: nullable(timestamp), ownerId: id, result: nullable(ref('Result')),
    role: { type: 'string', enum: ['guest', 'member', 'admin', 'owner'] }, canManage: boolean, isMutable: boolean,
  }),
  Registration: object({
    id: { type: 'string', pattern: '^\\d+$' }, participantId: id, displayName: name,
    primaryGameId: id, finalGameId: nullable(id), status: { type: 'string', enum: ['attendee', 'waitlist', 'unassigned'] },
    isHost: boolean, allocationReason: { type: ['string', 'null'], enum: ['primary', 'balanced', null] },
  }),
  WaitlistRegistration: { allOf: [ref('Registration'), object({ rank: { type: 'integer', minimum: 1 } })] },
  Game: object({
    id, name: text(50), capacity: gameFields.capacity!, description: text(500), difficulty: text(20),
    hostId: id, hostName: name, isHost: boolean,
    attendees: list(ref('Registration')), waitlist: list(ref('WaitlistRegistration')),
  }),
  EventView: object({
    event: ref('Event'), currentParticipantId: nullable(id), participant: nullable(ref('Participant')),
    registration: nullable(ref('Registration')), games: list(ref('Game')), unassigned: list(ref('Registration')),
    members: list(ref('Member')), testToolsEnabled: boolean, serverTime: { type: 'integer', description: 'Unix 毫秒。' },
  }),
  PreviewMember: object({ participantId: id, displayName: name, reason: { type: 'string', enum: ['host', 'primary', 'balanced'] } }),
  Preview: object({
    games: list(object({ id, name: text(50), capacity: gameFields.capacity!, attendees: list(ref('PreviewMember')) })),
    unassigned: list(object({ participantId: id, displayName: name })), result: ref('Result'),
  }),
  ErrorEnvelope: object({ error: object({ code: text(), message: text() }) }),
  DataEnvelope: envelope({}),
  SessionEnvelope: envelope(object({ participant: nullable(ref('Participant')) })),
  EventViewEnvelope: envelope(ref('EventView')),
  CreateEventEnvelope: envelope(object({ event: ref('Event'), managementKey: key })),
  ManagementKeyEnvelope: envelope(object({ managementKey: key })),
  PreviewEnvelope: envelope(ref('Preview')),
  CreateEventInput: object({ displayName: name, ...eventFields }, ['location', 'startAt', 'endAt']),
  EditEventInput: object(eventFields, []),
  CreateGameInput: object(gameFields, ['name', 'capacity']),
  EditGameInput: object(gameFields, []),
};

function requestSchema(method: string, path: string): Schema | undefined {
  if (method === 'POST' && path === '/session') return object({ displayName: name });
  if (method === 'POST' && path === '/events') return ref('CreateEventInput');
  if (method === 'PATCH' && path === '/events/:code') return ref('EditEventInput');
  if (method === 'POST' && path.endsWith('/members')) return object({ displayName: name });
  if (method === 'POST' && (path.endsWith('/games') || path.endsWith('/test-games'))) return ref('CreateGameInput');
  if (method === 'PATCH' && path === '/events/:code/games/:id') return ref('EditGameInput');
  if (method === 'POST' && path.endsWith('/manage')) return object({ managementKey: { ...key, writeOnly: true }, displayName: name }, ['managementKey']);
  if (method === 'PUT' && path === '/events/:code/admins/:id') return object({ isAdmin: boolean });
  if (method === 'POST' && path.endsWith('/owner-transfer')) return object({ participantId: id });
  if (method === 'POST' && path.endsWith('/test-users')) return object({ count: { type: 'integer', minimum: 1, maximum: 30 } });
  if (method === 'POST' && path.endsWith('/test-users/:id/join')) return object({ gameId: id });
  return undefined;
}

function responseSchema(method: string, path: string): Schema {
  if (path === '/openapi.json') return object({ openapi: { const: '3.1.0' }, info: { type: 'object' }, paths: { type: 'object' } });
  if (path === '/session') return ref('SessionEnvelope');
  if (method === 'POST' && path === '/events') return ref('CreateEventEnvelope');
  if (method === 'GET' && (path === '/events/:code' || path.endsWith('/results'))) return ref('EventViewEnvelope');
  if (method === 'GET' && path === '/events/resolve/:code') return envelope(object({ code }));
  if (path.endsWith('/management-key')) return ref('ManagementKeyEnvelope');
  if (path.endsWith('/owner-transfer')) return envelope(object({ ownerId: id }));
  if (path.endsWith('/preview')) return ref('PreviewEnvelope');
  return ref('DataEnvelope');
}

const summaries: Record<string, string> = {
  'GET /session': '读取基础匿名身份', 'POST /session': '创建或更新基础匿名身份', 'POST /events': '创建活动并成为 owner',
  'GET /events/resolve/:code': '解析活动码', 'GET /events/:code': '读取活动、名单及自己的状态',
  'GET /events/:code/results': '读取结果；已到期时补做结算', 'POST /events/:code/members': '填写姓名加入活动或更名',
  'PATCH /events/:code': 'owner/admin 编辑活动', 'DELETE /events/:code': 'owner/admin 删除报名期活动',
  'POST /events/:code/games': '成员开桌，host 自动入席', 'PATCH /events/:code/games/:id': 'host 编辑桌游，扩容自动补位',
  'DELETE /events/:code/games/:id': 'host 删桌并释放全部报名', 'POST /events/:code/games/:id/registrations': '报名主选桌或进入候补',
  'DELETE /events/:code/my-registration': '退出自己的非 host 报名并晋级候补',
  'POST /events/:code/manage': '用密钥恢复当前活动 owner 权限', 'POST /events/:code/management-key': 'owner 轮换密钥并撤销其他恢复授权',
  'PUT /events/:code/admins/:id': 'owner 任免活动管理员', 'POST /events/:code/owner-transfer': 'owner 转让；旧密钥和恢复授权失效',
  'POST /events/:code/preview': '只读分配预览', 'POST /events/:code/test-users': '创建测试成员',
  'POST /events/:code/test-games': '创建测试 Host 与桌游', 'POST /events/:code/test-fill': '均匀报名未报名测试成员',
  'POST /events/:code/test-reuse': '复用当前 owner 池中的未关联测试身份',
  'POST /events/:code/test-users/:id/join': '模拟测试成员报名', 'POST /events/:code/test-users/:id/drop': '模拟测试成员退出',
  'DELETE /events/:code/test-users': '清除测试成员及其关联报名', 'DELETE /events/:code/test-event': '清除活动并保留测试身份供复用',
  'GET /health/live': '进程健康检查', 'GET /health/ready': '数据库就绪检查', 'GET /openapi.json': '原始 OpenAPI 描述',
};

export function buildOpenApi(routes: Route[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const { method: rawMethod, path } of routes) {
    const method = rawMethod.toUpperCase();
    const openPath = path.replace(/:([a-zA-Z]+)/g, '{$1}');
    const isTest = path.includes('/test-') || path.endsWith('/preview');
    const isPublic = method === 'GET' || path === '/session' || (method === 'POST' && (path === '/events' || path.endsWith('/members') || path.endsWith('/manage')));
    const schema = requestSchema(method, path);
    const responses: Record<string, unknown> = {
      '200': { description: path === '/openapi.json' ? '原始 OpenAPI JSON，不使用 data 包装。' : '成功，data 包含操作结果。', content: { 'application/json': { schema: responseSchema(method, path) } } },
    };
    for (const [status, description] of Object.entries({
      '400': '字段或活动码无效', '401': '缺少有效匿名凭证或活动成员身份', '403': '权限、管理密钥、来源或环境限制',
      '404': '活动或目标不存在/已清理', '409': '已报名、同名、已截止或事务竞争', '413': '请求体超过限制',
      '415': '写请求必须为 JSON', '429': '请求过于频繁', '500': '内部错误',
    })) responses[status] = { description, content: { 'application/json': { schema: ref('ErrorEnvelope') } } };
    const operation = {
      operationId: method.toLowerCase() + path.split('/').filter(Boolean).map((part) => part.startsWith(':') ? `By${part[1]!.toUpperCase()}${part.slice(2)}` : part.split(/[-.]/).map((word) => word[0]!.toUpperCase() + word.slice(1)).join('')).join(''),
      summary: summaries[`${method} ${path}`] ?? `${method} ${path}`,
      description: isTest ? '仅非生产环境 ENABLE_TEST_TOOLS=true 且当前活动有效角色为 owner 时可调用。' : path === '/events' && method === 'POST' ? '首次创建匿名身份须提供 displayName。已存在的会话可沿用姓名。' : '匿名 Cookie 由服务端识别；姓名或 participantId 不能代替凭证。',
      tags: [isTest ? 'test-tools' : path.startsWith('/health') || path === '/openapi.json' ? 'system' : path === '/session' ? 'identity' : path.includes('/games') || path.endsWith('/my-registration') ? 'games' : 'events'],
      security: isPublic ? [{}, { anonymousSession: [] }] : [{ anonymousSession: [] }],
      parameters: [...path.matchAll(/:([a-zA-Z]+)/g)].map((match) => ({ name: match[1], in: 'path', required: true, schema: match[1] === 'code' ? { ...text(), description: '8 位活动码；输入可含小写、空格或连字符。' } : id })),
      ...(schema ? { requestBody: { required: true, content: { 'application/json': { schema } } } } : {}), responses,
    };
    paths[openPath] ??= {};
    paths[openPath]![method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Board Game Organizer API', version: '1.0.0', description: '姓名即可参加的桌游活动。普通活动链接可公开读取；业务写入以匿名 Cookie 鉴权，管理密钥恢复仅作用于指定活动。' },
    servers: [{ url: '/api/v1' }], paths,
    components: { securitySchemes: { anonymousSession: { type: 'apiKey', in: 'cookie', name: 'bg_session', description: '服务端设置的 HttpOnly 匿名 Cookie；不要使用 participantId 或姓名代替。' } }, schemas },
  };
}
