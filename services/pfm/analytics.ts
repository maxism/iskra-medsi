import { getPFMStore, Operation } from './store';

export type PFMIntent =
  | 'spendByCategory'
  | 'topMerchants'
  | 'cashflowByMonth'
  | 'anomalies'
  | 'totalExpense'
  | 'largestExpense'
  | 'telecomSpend';

export type TimeRangePreset =
  | 'this_month'
  | 'last_month'
  | 'this_year'
  | 'all_time'
  | 'custom';

export interface TimeRange {
  preset: TimeRangePreset;
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
}

export interface PFMQuery {
  intent: PFMIntent;
  timeRange: TimeRange;
  filters?: {
    category?: string;
    merchant?: string;
    minAbsAmount?: number;
    currency?: string;
    expenseOnly?: boolean;
  };
  limit?: number;
  groupBy?: 'category' | 'merchant';
}

export interface CategorySpendRow {
  category: string;
  total: number; // positive rubles
  count: number;
}

export interface MerchantSpendRow {
  merchant: string;
  total: number; // positive rubles
  count: number;
  avg: number;
  categoryTop?: string;
}

export interface CashflowMonthRow {
  month: string; // YYYY-MM
  income: number;
  expense: number;
  net: number;
}

export interface AnomalyRow {
  key: string; // category or merchant
  periodTotal: number; // positive
  baselineAvg: number; // positive
  ratio: number;
  month: string;
}

export interface LargestExpenseRow {
  date: string; // YYYY-MM-DD
  merchant: string;
  category: string;
  amount: number; // positive
}

export interface TelecomSpendRow {
  provider: string;
  total: number; // positive
  count: number;
  exampleMerchants: string[];
}

export type PFMResult =
  | { type: 'spendByCategory'; range: { from: string; to: string }; currency: string; rows: CategorySpendRow[]; totalExpense: number }
  | { type: 'topMerchants'; range: { from: string; to: string }; currency: string; rows: MerchantSpendRow[]; totalExpense: number }
  | { type: 'cashflowByMonth'; range: { from: string; to: string }; currency: string; rows: CashflowMonthRow[] }
  | { type: 'anomalies'; range: { from: string; to: string }; currency: string; groupBy: 'category' | 'merchant'; rows: AnomalyRow[] }
  | { type: 'totalExpense'; range: { from: string; to: string }; currency: string; totalExpense: number; count: number }
  | { type: 'largestExpense'; range: { from: string; to: string }; currency: string; row: LargestExpenseRow | null }
  | { type: 'telecomSpend'; range: { from: string; to: string }; currency: string; total: number; rows: TelecomSpendRow[] };

function normalizeText(x: string): string {
  return x.toLowerCase().replace(/\s+/g, ' ').trim();
}

type ProviderRule = { provider: string; match: (text: string) => boolean };
const TELECOM_RULES: ProviderRule[] = [
  { provider: 'МТС', match: (t) => /\bмтс\b/.test(t) || t.includes('mts') || t.includes('mts ') || t.includes('mts-') },
  { provider: 'Билайн', match: (t) => t.includes('билайн') || t.includes('beeline') },
  { provider: 'Мегафон', match: (t) => t.includes('мегафон') || t.includes('megafon') },
  { provider: 'Tele2', match: (t) => t.includes('tele2') || t.includes('теле2') || /\bt2\b/.test(t) },
  { provider: 'Ростелеком', match: (t) => t.includes('ростелеком') || t.includes('rostelecom') },
  { provider: 'Yota', match: (t) => t.includes('yota') || t.includes('йота') },
  { provider: 'Дом.ру', match: (t) => t.includes('дом.ру') || t.includes('dom.ru') || t.includes('er-telecom') },
  { provider: 'Тинькофф Мобайл', match: (t) => t.includes('tinkoff mobile') || t.includes('тинькофф моб') },
];

function detectTelecomProvider(op: Operation): string | null {
  const cat = normalizeText(op.category);
  const text = normalizeText(`${op.descriptionRaw} ${op.merchant} ${op.category}`);

  // Category-first: if the bank already labeled it as telecom, include it even
  // when provider name is not present in the description.
  const isMobileCategory = cat.includes('мобиль') && cat.includes('связ');
  const isTelecomCategory = cat.includes('связ');

  let provider: string | null = null;
  for (const rule of TELECOM_RULES) {
    if (rule.match(text)) { provider = rule.provider; break; }
  }

  if (provider) return provider;
  if (isMobileCategory) return 'Мобильная связь (оператор не указан)';
  if (isTelecomCategory) return 'Прочая связь';
  return null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toDateISO(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function resolveTimeRange(range: TimeRange, ops: readonly Operation[]): { from: string; to: string; fromTs: number; toTs: number } {
  const now = new Date();

  let from: string;
  let to: string;

  if (range.preset === 'custom' && range.from && range.to) {
    from = range.from;
    to = range.to;
  } else if (range.preset === 'last_month') {
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    from = toDateISO(startOfMonth(prev));
    to = toDateISO(endOfMonth(prev));
  } else if (range.preset === 'this_year') {
    from = `${now.getFullYear()}-01-01`;
    to = toDateISO(now);
  } else if (range.preset === 'all_time') {
    const first = ops.length > 0 ? new Date(ops[0].ts) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const last = ops.length > 0 ? new Date(ops[ops.length - 1].ts) : first;
    from = toDateISO(first);
    to = toDateISO(last);
  } else {
    // this_month (default)
    from = toDateISO(startOfMonth(now));
    to = toDateISO(now);
  }

  const fromTs = Date.parse(`${from}T00:00:00`);
  const toTs = Date.parse(`${to}T23:59:59`);
  return { from, to, fromTs, toTs };
}

function opMatchesFilters(op: Operation, filters: NonNullable<PFMQuery['filters']>): boolean {
  if (filters.currency && op.currency !== filters.currency) return false;
  if (filters.category && op.category.toLowerCase() !== filters.category.toLowerCase()) return false;
  if (filters.merchant && op.merchant.toLowerCase() !== filters.merchant.toLowerCase()) return false;
  if (typeof filters.minAbsAmount === 'number' && op.absAmount < filters.minAbsAmount) return false;
  if (filters.expenseOnly && !op.isExpense) return false;
  return true;
}

function sliceOps(query: PFMQuery): { ops: Operation[]; range: { from: string; to: string } } {
  const store = getPFMStore();
  const resolved = resolveTimeRange(query.timeRange, store.operations);
  const filters = query.filters ?? {};

  const ops = store.operations
    .filter((op) => op.ts >= resolved.fromTs && op.ts <= resolved.toTs)
    .filter((op) => opMatchesFilters(op, filters));

  return { ops, range: { from: resolved.from, to: resolved.to } };
}

function sumExpensePositive(ops: readonly Operation[], currency: string): number {
  return ops
    .filter((op) => op.currency === currency && op.isExpense)
    .reduce((acc, op) => acc + op.absAmount, 0);
}

function guessCurrency(ops: readonly Operation[]): string {
  // dataset looks RUB-only, but keep generic
  const counts = new Map<string, number>();
  for (const op of ops) counts.set(op.currency, (counts.get(op.currency) ?? 0) + 1);
  let best = 'RUB';
  let bestN = -1;
  for (const [cur, n] of counts) {
    if (n > bestN) { bestN = n; best = cur; }
  }
  return best;
}

export function runPFMQuery(query: PFMQuery): PFMResult {
  const { ops, range } = sliceOps(query);
  const currency = query.filters?.currency ?? guessCurrency(ops);

  if (query.intent === 'telecomSpend') {
    const byProvider = new Map<string, { total: number; count: number; examples: Set<string> }>();
    let total = 0;

    for (const op of ops) {
      if (!op.isExpense) continue;
      if (op.currency !== currency) continue;

      const provider = detectTelecomProvider(op);
      if (!provider) continue;

      total += op.absAmount;
      const prev = byProvider.get(provider);
      if (prev) {
        prev.total += op.absAmount;
        prev.count += 1;
        if (prev.examples.size < 5) prev.examples.add(op.merchant);
      } else {
        const examples = new Set<string>();
        examples.add(op.merchant);
        byProvider.set(provider, { total: op.absAmount, count: 1, examples });
      }
    }

    const rows: TelecomSpendRow[] = Array.from(byProvider.entries())
      .map(([provider, v]) => ({
        provider,
        total: v.total,
        count: v.count,
        exampleMerchants: Array.from(v.examples),
      }))
      .sort((a, b) => b.total - a.total);

    return { type: 'telecomSpend', range, currency, total, rows };
  }

  if (query.intent === 'totalExpense') {
    const expenseOps = ops.filter((op) => op.currency === currency && op.isExpense);
    const totalExpense = expenseOps.reduce((acc, op) => acc + op.absAmount, 0);
    return { type: 'totalExpense', range, currency, totalExpense, count: expenseOps.length };
  }

  if (query.intent === 'largestExpense') {
    let best: Operation | null = null;
    for (const op of ops) {
      if (!op.isExpense) continue;
      if (op.currency !== currency) continue;
      if (!best || op.absAmount > best.absAmount) best = op;
    }
    return {
      type: 'largestExpense',
      range,
      currency,
      row: best
        ? { date: best.date, merchant: best.merchant, category: best.category, amount: best.absAmount }
        : null,
    };
  }

  if (query.intent === 'spendByCategory') {
    const byCat = new Map<string, { total: number; count: number }>();
    for (const op of ops) {
      if (!op.isExpense) continue;
      if (op.currency !== currency) continue;
      const key = op.category;
      const prev = byCat.get(key);
      if (prev) {
        prev.total += op.absAmount;
        prev.count += 1;
      } else {
        byCat.set(key, { total: op.absAmount, count: 1 });
      }
    }
    const rows: CategorySpendRow[] = Array.from(byCat.entries())
      .map(([category, v]) => ({ category, total: v.total, count: v.count }))
      .sort((a, b) => b.total - a.total);

    const limit = query.limit ?? 10;
    const sliced = rows.slice(0, Math.max(1, limit));
    const totalExpense = sumExpensePositive(ops, currency);
    return { type: 'spendByCategory', range, currency, rows: sliced, totalExpense };
  }

  if (query.intent === 'topMerchants') {
    const byMerch = new Map<string, { total: number; count: number; catCounts: Map<string, number> }>();
    for (const op of ops) {
      if (!op.isExpense) continue;
      if (op.currency !== currency) continue;
      const key = op.merchant;
      const prev = byMerch.get(key);
      if (prev) {
        prev.total += op.absAmount;
        prev.count += 1;
        prev.catCounts.set(op.category, (prev.catCounts.get(op.category) ?? 0) + 1);
      } else {
        const catCounts = new Map<string, number>();
        catCounts.set(op.category, 1);
        byMerch.set(key, { total: op.absAmount, count: 1, catCounts });
      }
    }

    const rows: MerchantSpendRow[] = Array.from(byMerch.entries())
      .map(([merchant, v]) => {
        let categoryTop: string | undefined;
        let best = -1;
        for (const [cat, n] of v.catCounts) {
          if (n > best) { best = n; categoryTop = cat; }
        }
        return {
          merchant,
          total: v.total,
          count: v.count,
          avg: v.count > 0 ? v.total / v.count : 0,
          categoryTop,
        };
      })
      .sort((a, b) => b.total - a.total);

    const limit = query.limit ?? 10;
    const sliced = rows.slice(0, Math.max(1, limit));
    const totalExpense = sumExpensePositive(ops, currency);
    return { type: 'topMerchants', range, currency, rows: sliced, totalExpense };
  }

  if (query.intent === 'cashflowByMonth') {
    const byMonth = new Map<string, { income: number; expense: number }>();
    for (const op of ops) {
      if (op.currency !== currency) continue;
      const prev = byMonth.get(op.month);
      const incomeAdd = op.isExpense ? 0 : op.amount;
      const expenseAdd = op.isExpense ? op.absAmount : 0;
      if (prev) {
        prev.income += incomeAdd;
        prev.expense += expenseAdd;
      } else {
        byMonth.set(op.month, { income: incomeAdd, expense: expenseAdd });
      }
    }
    const rows: CashflowMonthRow[] = Array.from(byMonth.entries())
      .map(([month, v]) => ({ month, income: v.income, expense: v.expense, net: v.income - v.expense }))
      .sort((a, b) => a.month.localeCompare(b.month));
    return { type: 'cashflowByMonth', range, currency, rows };
  }

  // anomalies
  const groupBy: 'category' | 'merchant' = query.groupBy ?? 'category';

  // Baseline: average monthly expense per group across the full dataset (excluding the target period month)
  const store = getPFMStore();
  const resolved = resolveTimeRange(query.timeRange, store.operations);
  const targetMonths = new Set<string>();
  for (const op of store.operations) {
    if (op.ts >= resolved.fromTs && op.ts <= resolved.toTs) targetMonths.add(op.month);
  }

  const monthlyByGroup = new Map<string, Map<string, number>>(); // group -> month -> expenseTotal
  for (const op of store.operations) {
    if (!op.isExpense) continue;
    if (op.currency !== currency) continue;
    const key = groupBy === 'merchant' ? op.merchant : op.category;
    const m = op.month;
    let monthMap = monthlyByGroup.get(key);
    if (!monthMap) {
      monthMap = new Map<string, number>();
      monthlyByGroup.set(key, monthMap);
    }
    monthMap.set(m, (monthMap.get(m) ?? 0) + op.absAmount);
  }

  // Period totals for target range
  const periodTotals = new Map<string, number>();
  for (const op of ops) {
    if (!op.isExpense) continue;
    if (op.currency !== currency) continue;
    const key = groupBy === 'merchant' ? op.merchant : op.category;
    periodTotals.set(key, (periodTotals.get(key) ?? 0) + op.absAmount);
  }

  const rows: AnomalyRow[] = [];
  for (const [key, periodTotal] of periodTotals) {
    const monthMap = monthlyByGroup.get(key);
    if (!monthMap) continue;
    const baselineMonths = Array.from(monthMap.entries())
      .filter(([m]) => !targetMonths.has(m))
      .map(([, v]) => v);
    if (baselineMonths.length < 2) continue;
    const baselineAvg = baselineMonths.reduce((a, b) => a + b, 0) / baselineMonths.length;
    if (baselineAvg <= 0) continue;

    const ratio = periodTotal / baselineAvg;
    // Heuristic threshold: “significant” > 1.8x
    if (ratio >= 1.8 && periodTotal >= 2000) {
      const month = Array.from(targetMonths).sort().slice(-1)[0] ?? range.from.slice(0, 7);
      rows.push({ key, periodTotal, baselineAvg, ratio, month });
    }
  }

  rows.sort((a, b) => b.ratio - a.ratio);
  const limit = query.limit ?? 8;
  return { type: 'anomalies', range, currency, groupBy, rows: rows.slice(0, Math.max(1, limit)) };
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function sanityCheckResult(result: PFMResult): void {
  const fail = (msg: string) => { throw new Error(`[PFM] sanity-check failed: ${msg}`); };

  if (result.type === 'spendByCategory' || result.type === 'topMerchants' || result.type === 'totalExpense') {
    if (!isFiniteNumber(result.totalExpense) || result.totalExpense < 0) fail('totalExpense invalid');
    if (result.type !== 'totalExpense') {
      for (const row of result.rows) {
        if (!isFiniteNumber(row.total) || row.total < 0) fail('row total invalid');
        if (!Number.isFinite(row.count) || row.count < 0) fail('row count invalid');
      }
    } else {
      if (!Number.isFinite(result.count) || result.count < 0) fail('count invalid');
    }
  }
  if (result.type === 'cashflowByMonth') {
    for (const row of result.rows) {
      if (!isFiniteNumber(row.income) || !isFiniteNumber(row.expense) || !isFiniteNumber(row.net)) fail('cashflow row invalid');
    }
  }
  if (result.type === 'anomalies') {
    for (const row of result.rows) {
      if (!isFiniteNumber(row.periodTotal) || !isFiniteNumber(row.baselineAvg) || !isFiniteNumber(row.ratio)) fail('anomaly row invalid');
    }
  }
  if (result.type === 'largestExpense' && result.row) {
    if (!isFiniteNumber(result.row.amount) || result.row.amount < 0) fail('largest amount invalid');
  }
  if (result.type === 'telecomSpend') {
    if (!isFiniteNumber(result.total) || result.total < 0) fail('telecom total invalid');
    for (const row of result.rows) {
      if (!isFiniteNumber(row.total) || row.total < 0) fail('telecom row total invalid');
      if (!Number.isFinite(row.count) || row.count < 0) fail('telecom row count invalid');
    }
  }
}

type CacheEntry = { savedAt: number; result: PFMResult };
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

export function runPFMQueryCached(query: PFMQuery): PFMResult {
  const key = JSON.stringify(query);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && (now - cached.savedAt) < CACHE_TTL_MS) return cached.result;

  const result = runPFMQuery(query);
  sanityCheckResult(result);
  cache.set(key, { savedAt: now, result });
  return result;
}

