import { llmChatCompletion } from '../llm';
import { getPFMStore } from './store';
import { PFMIntent, PFMQuery, TimeRangePreset } from './analytics';

function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractJsonObject(raw: string): string {
  const cleaned = stripFences(raw);
  const match = cleaned.match(/\{[\s\S]*\}/);
  return (match ? match[0] : cleaned).trim();
}

function isPreset(x: unknown): x is TimeRangePreset {
  return x === 'this_month' || x === 'last_month' || x === 'this_year' || x === 'all_time' || x === 'custom';
}

function isIntent(x: unknown): x is PFMIntent {
  return x === 'spendByCategory'
    || x === 'topMerchants'
    || x === 'cashflowByMonth'
    || x === 'anomalies'
    || x === 'totalExpense'
    || x === 'largestExpense'
    || x === 'telecomSpend';
}

function isISODate(x: unknown): x is string {
  return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
}

function toLowerSafe(x: unknown): string {
  return typeof x === 'string' ? x.toLowerCase() : '';
}

function fuzzyPick(needle: string, options: readonly string[]): string | undefined {
  const n = needle.trim().toLowerCase();
  if (!n) return undefined;

  // exact match
  const exact = options.find((o) => o.toLowerCase() === n);
  if (exact) return exact;

  // contains
  const contains = options.find((o) => o.toLowerCase().includes(n));
  if (contains) return contains;

  return undefined;
}

export function looksLikePFMQuestion(text: string): boolean {
  const t = toLowerSafe(text);
  const keywords = [
    'траты', 'потрат', 'расход', 'расходы', 'покупк', 'покупка', 'сколько', 'куда', 'категор', 'мерчант',
    'где', 'магазин', 'кафе', 'ресторан', 'такси', 'супермаркет', 'аномал', 'скачок',
    'по месяц', 'месяц', 'год', 'доход', 'кэшфлоу', 'нетто',
    'связ', 'мобильн', 'интернет', 'телефон',
    'мтс', 'билайн', 'beeline', 'megafon', 'мегафон', 'tele2', 'теле2', 'ростелеком', 'rostelecom', 'yota', 'йота',
    'январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр',
  ];
  return keywords.some((k) => t.includes(k));
}

const MONTHS: Array<{ n: number; forms: string[] }> = [
  { n: 1, forms: ['январь', 'января', 'январе'] },
  { n: 2, forms: ['февраль', 'февраля', 'феврале'] },
  { n: 3, forms: ['март', 'марта', 'марте'] },
  { n: 4, forms: ['апрель', 'апреля', 'апреле'] },
  { n: 5, forms: ['май', 'мая', 'мае'] },
  { n: 6, forms: ['июнь', 'июня', 'июне'] },
  { n: 7, forms: ['июль', 'июля', 'июле'] },
  { n: 8, forms: ['август', 'августа', 'августе'] },
  { n: 9, forms: ['сентябрь', 'сентября', 'сентябре'] },
  { n: 10, forms: ['октябрь', 'октября', 'октябре'] },
  { n: 11, forms: ['ноябрь', 'ноября', 'ноябре'] },
  { n: 12, forms: ['декабрь', 'декабря', 'декабре'] },
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function lastDayOfMonth(year: number, month1to12: number): number {
  return new Date(year, month1to12, 0).getDate();
}

function detectMonthNumber(text: string): number | null {
  const t = toLowerSafe(text);
  for (const m of MONTHS) {
    if (m.forms.some((f) => t.includes(f))) return m.n;
  }
  return null;
}

function resolveMonthYear(month1to12: number): number | null {
  const store = getPFMStore();
  const ops = store.operations;
  if (ops.length === 0) return null;
  const min = new Date(ops[0].ts);
  const max = new Date(ops[ops.length - 1].ts);
  const minYear = min.getFullYear();
  const maxYear = max.getFullYear();

  // Pick the latest year where that month intersects the dataset range.
  for (let y = maxYear; y >= minYear; y--) {
    const from = Date.parse(`${y}-${pad2(month1to12)}-01T00:00:00`);
    const to = Date.parse(`${y}-${pad2(month1to12)}-${pad2(lastDayOfMonth(y, month1to12))}T23:59:59`);
    if (to >= ops[0].ts && from <= ops[ops.length - 1].ts) return y;
  }
  return null;
}

function applyMonthRangeIfPresent(query: PFMQuery, text: string): void {
  const m = detectMonthNumber(text);
  if (!m) return;
  const y = resolveMonthYear(m);
  if (!y) return;
  const from = `${y}-${pad2(m)}-01`;
  const to = `${y}-${pad2(m)}-${pad2(lastDayOfMonth(y, m))}`;
  query.timeRange = { preset: 'custom', from, to };
}

function fallbackIntent(text: string): PFMIntent {
  const t = toLowerSafe(text);
  if (t.includes('связ') || t.includes('мобильн') || t.includes('оператор') || t.includes('интернет')) return 'telecomSpend';
  if (t.includes('самая') && (t.includes('покупк') || t.includes('трата') || t.includes('расход'))) return 'largestExpense';
  if (t.includes('сумма') && (t.includes('трат') || t.includes('расход'))) return 'totalExpense';
  if (t.includes('аномал') || t.includes('скач')) return 'anomalies';
  if (t.includes('кэшфлоу') || t.includes('доход') || t.includes('нетто')) return 'cashflowByMonth';
  if (t.includes('мерчант') || t.includes('где') || t.includes('магазин') || t.includes('ресторан') || t.includes('кафе')) return 'topMerchants';
  return 'spendByCategory';
}

function fallbackPreset(text: string): TimeRangePreset {
  const t = toLowerSafe(text);
  if (t.includes('вс') && (t.includes('период') || t.includes('время') || t.includes('всё'))) return 'all_time';
  if (t.includes('прошл') && t.includes('месяц')) return 'last_month';
  if (t.includes('эт') && t.includes('год')) return 'this_year';
  if (t.includes('эт') && t.includes('месяц')) return 'this_month';
  return 'this_month';
}

export async function parsePFMQuery(text: string): Promise<PFMQuery | null> {
  if (!looksLikePFMQuestion(text)) return null;

  const system = [
    'Ты — парсер запроса к персональной аналитике трат (PFM).',
    'Верни ТОЛЬКО валидный JSON без markdown и без пояснений.',
    '',
    'Схема ответа:',
    '{',
    '  "intent": "spendByCategory|topMerchants|cashflowByMonth|anomalies|totalExpense|largestExpense|telecomSpend",',
    '  "timeRange": { "preset": "this_month|last_month|this_year|all_time|custom", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" },',
    '  "filters": { "category": string, "merchant": string, "minAbsAmount": number, "currency": "RUB", "expenseOnly": boolean },',
    '  "limit": number,',
    '  "groupBy": "category|merchant"',
    '}',
    '',
    'Правила:',
    '- Если период не указан — preset=this_month.',
    '- Если пользователь спрашивает «сколько потратил по категориям» — intent=spendByCategory.',
    '- Если пользователь спрашивает «какая сумма трат» — intent=totalExpense.',
    '- Если пользователь спрашивает «самая большая покупка / трата» — intent=largestExpense.',
    '- Если пользователь спрашивает «сколько потратил на связь / оператора / интернет» — intent=telecomSpend.',
    '- Если «где / в каких местах / топ мест» — intent=topMerchants.',
    '- Если «по месяцам / доходы и расходы / кэшфлоу» — intent=cashflowByMonth.',
    '- Если «аномальные траты / скачки» — intent=anomalies и groupBy=category по умолчанию.',
    '- currency по умолчанию RUB.',
  ].join('\n');

  let raw = '';
  try {
    raw = await llmChatCompletion(system, text, { max_tokens: 400, temperature: 0 });
  } catch {
    // fall back to heuristics
    const q: PFMQuery = {
      intent: fallbackIntent(text),
      timeRange: { preset: fallbackPreset(text) },
      filters: { currency: 'RUB', expenseOnly: true },
      limit: 10,
      groupBy: 'category',
    };
    applyMonthRangeIfPresent(q, text);
    return q;
  }

  const jsonText = extractJsonObject(raw);

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const q: PFMQuery = {
      intent: fallbackIntent(text),
      timeRange: { preset: fallbackPreset(text) },
      filters: { currency: 'RUB', expenseOnly: true },
      limit: 10,
      groupBy: 'category',
    };
    applyMonthRangeIfPresent(q, text);
    return q;
  }

  const intent: PFMIntent = isIntent(parsed.intent) ? parsed.intent : fallbackIntent(text);
  const preset: TimeRangePreset = isPreset(parsed?.timeRange?.preset) ? parsed.timeRange.preset : fallbackPreset(text);

  const timeRange = {
    preset,
    from: isISODate(parsed?.timeRange?.from) ? parsed.timeRange.from : undefined,
    to: isISODate(parsed?.timeRange?.to) ? parsed.timeRange.to : undefined,
  };

  const limit = typeof parsed.limit === 'number' && Number.isFinite(parsed.limit)
    ? Math.max(1, Math.min(50, Math.floor(parsed.limit)))
    : 10;

  const groupBy: 'category' | 'merchant' = parsed.groupBy === 'merchant' ? 'merchant' : 'category';

  const store = getPFMStore();
  const category = typeof parsed?.filters?.category === 'string'
    ? (fuzzyPick(parsed.filters.category, store.categories) ?? parsed.filters.category)
    : undefined;

  const merchant = typeof parsed?.filters?.merchant === 'string'
    ? parsed.filters.merchant.trim()
    : undefined;

  const minAbsAmount = typeof parsed?.filters?.minAbsAmount === 'number' && Number.isFinite(parsed.filters.minAbsAmount)
    ? Math.max(0, parsed.filters.minAbsAmount)
    : undefined;

  const currency = typeof parsed?.filters?.currency === 'string' && parsed.filters.currency.trim().length > 0
    ? parsed.filters.currency.trim().toUpperCase()
    : 'RUB';

  const expenseOnly = typeof parsed?.filters?.expenseOnly === 'boolean'
    ? parsed.filters.expenseOnly
    : true;

  const query: PFMQuery = {
    intent,
    timeRange,
    filters: {
      ...(category ? { category } : {}),
      ...(merchant ? { merchant } : {}),
      ...(typeof minAbsAmount === 'number' ? { minAbsAmount } : {}),
      currency,
      expenseOnly,
    },
    limit,
    ...(intent === 'anomalies' ? { groupBy } : {}),
  };

  // If user explicitly mentioned a month name (январь/декабрь/...), prefer it.
  applyMonthRangeIfPresent(query, text);

  // If preset=custom but dates missing, downgrade to this_month to avoid empty results.
  if (query.timeRange.preset === 'custom' && (!query.timeRange.from || !query.timeRange.to)) {
    query.timeRange = { preset: fallbackPreset(text) };
  }

  return query;
}

