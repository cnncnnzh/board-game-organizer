export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function assert(condition: unknown, code: string, message: string, statusCode = 400): asserts condition {
  if (!condition) throw new AppError(code, message, statusCode);
}

export function cleanText(value: unknown, maxLength: number, field: string, required = true): string {
  assert(value === undefined || value === null || typeof value === 'string', 'INVALID_INPUT', `${field}格式不正确`);
  const text = (typeof value === 'string' ? value : '').trim();
  if (required) assert(text.length > 0, 'INVALID_INPUT', `请填写${field}`);
  assert([...text].length <= maxLength, 'INVALID_INPUT', `${field}不能超过 ${maxLength} 个字`);
  assert(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(text), 'INVALID_INPUT', `${field}包含无效字符`);
  return text;
}

export function validateName(value: unknown): string {
  assert(typeof value === 'string', 'INVALID_INPUT', '请填写姓名或微信名');
  const name = cleanText(value.normalize('NFKC'), 40, '姓名或微信名');
  assert(!/[\u0000-\u001F\u007F-\u009F]/u.test(name), 'INVALID_INPUT', '姓名或微信名不能包含换行或控制字符');
  return name;
}

function parseDate(value: unknown, field: string): Date {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value),
    'INVALID_INPUT', `${field}需包含明确时区`);
  const date = new Date(value);
  assert(Number.isFinite(date.getTime()), 'INVALID_INPUT', `${field}格式不正确`);
  // Date normalizes impossible dates such as February 30; reject them explicitly.
  const [year, month, day] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  assert(month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth, 'INVALID_INPUT', `${field}日期不正确`);
  return date;
}

export function validateEvent(payload: Record<string, unknown> = {}, {
  now = Date.now(), requireFutureStart = true,
}: { now?: number; requireFutureStart?: boolean } = {}) {
  const startAt = parseDate(payload.startAt, '开始时间');
  const endAt = parseDate(payload.endAt, '结束时间');
  if (requireFutureStart) {
    assert(startAt.getTime() > now + 24 * 60 * 60 * 1000, 'INVALID_INPUT', '活动开始时间需晚于当前时间 24 小时');
  }
  assert(endAt.getTime() > startAt.getTime(), 'INVALID_INPUT', '结束时间必须晚于开始时间');
  assert(endAt.getTime() - startAt.getTime() <= 3 * 24 * 60 * 60 * 1000, 'INVALID_INPUT', '单次活动不能超过 3 天');
  const timeZone = cleanText(payload.timeZone ?? 'America/Chicago', 100, '时区');
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(startAt);
  } catch {
    throw new AppError('INVALID_INPUT', '请选择有效的 IANA 时区');
  }
  return {
    title: cleanText(payload.title || '桌游聚会', 40, '活动名称'),
    location: cleanText(payload.location, 100, '地点'),
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    timeZone,
    registrationClosesAt: new Date(startAt.getTime() - 24 * 60 * 60 * 1000).toISOString(),
  };
}

export function validateGame(payload: Record<string, unknown> = {}) {
  assert(typeof payload.capacity === 'number' || typeof payload.capacity === 'string', 'INVALID_INPUT', '人数上限必须为整数');
  const capacity = Number(payload.capacity);
  assert(Number.isInteger(capacity), 'INVALID_INPUT', '人数上限必须为整数');
  assert(capacity >= 1 && capacity <= 100, 'INVALID_INPUT', '人数上限需要在 1 到 100 之间');
  return {
    name: cleanText(payload.name, 50, '桌游名称'),
    capacity,
    description: cleanText(payload.description, 500, '简介', false),
    difficulty: cleanText(payload.difficulty, 20, '难度', false),
  };
}
