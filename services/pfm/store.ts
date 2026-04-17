export interface RawOperation {
  operationDateTime: string; // ISO-like "2026-04-16T15:14:27"
  paymentDate: string | null; // "2026-04-16" or null
  cardNumber: string | null;
  status: string;
  operationAmount: number; // expense is negative
  operationCurrency: string;
  paymentAmount: number;
  paymentCurrency: string;
  cashback: number | null;
  category: string | null;
  mcc: string | null;
  description: string | null;
  bonusIncludingCashback: number | null;
  roundingToInvestJar: number | null;
  operationAmountWithRounding: number | null;
}

export interface Operation {
  id: string;
  ts: number; // epoch ms
  date: string; // YYYY-MM-DD
  month: string; // YYYY-MM
  status: string;
  currency: string;
  amount: number; // signed
  absAmount: number; // absolute value of amount
  isExpense: boolean;
  category: string; // normalized non-empty
  mcc?: string;
  merchant: string; // normalized from description
  descriptionRaw: string; // original description (trimmed, may be "Неизвестно")
  cashback?: number;
  cardTail?: string;
}

export interface PFMStore {
  operations: readonly Operation[];
  byMonth: ReadonlyMap<string, readonly Operation[]>;
  categories: readonly string[];
  merchants: readonly string[];
}

function safeString(x: unknown, fallback: string): string {
  const s = typeof x === 'string' ? x.trim() : '';
  return s.length > 0 ? s : fallback;
}

function normalizeMerchant(description: string): string {
  const base = description
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_');

  // Common normalizations for “same merchant, different casing/spelling”
  const lowered = base.toLowerCase();
  if (lowered.includes('яндекс') && lowered.includes('такси')) return 'Яндекс Такси';
  if (lowered.includes('mos.ru')) return 'MOS.RU';
  if (lowered.includes('метрополитен')) return 'Московский метрополитен';

  // Capitalize first char (keep the rest)
  return base.length > 0 ? base[0].toUpperCase() + base.slice(1) : 'Неизвестно';
}

function monthKeyFromDate(dateIso: string): string {
  // dateIso expected YYYY-MM-DD
  return dateIso.slice(0, 7);
}

function buildId(op: RawOperation, idx: number): string {
  // Stable enough for local analytics: timestamp + amount + idx
  const dt = typeof op.operationDateTime === 'string' ? op.operationDateTime : '';
  const amt = typeof op.operationAmount === 'number' ? op.operationAmount : 0;
  return `${dt}|${amt}|${idx}`;
}

function parseDateParts(raw: RawOperation): { ts: number; date: string } {
  const dt = safeString(raw.operationDateTime, '');
  const d = dt.slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : safeString(raw.paymentDate, '1970-01-01');
  const ts = Date.parse(dt) || Date.parse(`${date}T00:00:00`);
  return { ts, date };
}

function normalizeOperation(raw: RawOperation, idx: number): Operation {
  const { ts, date } = parseDateParts(raw);
  const currency = safeString(raw.operationCurrency, 'RUB');
  const amount = typeof raw.operationAmount === 'number' ? raw.operationAmount : 0;
  const isExpense = amount < 0;
  const absAmount = Math.abs(amount);
  const category = safeString(raw.category, 'Без категории');
  const descriptionRaw = safeString(raw.description, 'Неизвестно');
  const merchant = normalizeMerchant(descriptionRaw);

  const cardTail = typeof raw.cardNumber === 'string' && raw.cardNumber.trim().length > 0
    ? raw.cardNumber.trim()
    : undefined;

  return {
    id: buildId(raw, idx),
    ts,
    date,
    month: monthKeyFromDate(date),
    status: safeString(raw.status, 'UNKNOWN'),
    currency,
    amount,
    absAmount,
    isExpense,
    category,
    mcc: typeof raw.mcc === 'string' && raw.mcc.trim().length > 0 ? raw.mcc.trim() : undefined,
    merchant,
    descriptionRaw,
    cashback: typeof raw.cashback === 'number' ? raw.cashback : undefined,
    cardTail,
  };
}

function loadRawOperationsFromBundledFile(): RawOperation[] {
  // Keep it explicit; can be extended later to support multiple dumps.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const data = require('../../data/operations_2025-10-01_2026-04-16.json') as unknown;
  if (!Array.isArray(data)) return [];
  return data as RawOperation[];
}

let cachedStore: PFMStore | null = null;

export function getPFMStore(): PFMStore {
  if (cachedStore) return cachedStore;

  const raw = loadRawOperationsFromBundledFile();
  const operations = raw.map((op, idx) => normalizeOperation(op, idx))
    // keep only successful operations for analytics
    .filter((op) => op.status === 'OK')
    // ensure deterministic ordering
    .sort((a, b) => a.ts - b.ts);

  const byMonth = new Map<string, Operation[]>();
  const categorySet = new Set<string>();
  const merchantSet = new Set<string>();

  for (const op of operations) {
    categorySet.add(op.category);
    merchantSet.add(op.merchant);

    const list = byMonth.get(op.month);
    if (list) list.push(op);
    else byMonth.set(op.month, [op]);
  }

  cachedStore = {
    operations,
    byMonth,
    categories: Array.from(categorySet).sort((a, b) => a.localeCompare(b, 'ru')),
    merchants: Array.from(merchantSet).sort((a, b) => a.localeCompare(b, 'ru')),
  };

  return cachedStore;
}

