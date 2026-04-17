import { PFMResult } from './analytics';

function formatMoney(amount: number, currency: string): string {
  const rounded = Math.round(amount * 100) / 100;
  const formatted = rounded.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const suffix = currency === 'RUB' ? '₽' : currency;
  return `${formatted} ${suffix}`;
}

function pct(part: number, total: number): string {
  if (total <= 0) return '0%';
  const p = Math.round((part / total) * 100);
  return `${p}%`;
}

export function formatPFMAnswer(result: PFMResult): string {
  if (result.type === 'telecomSpend') {
    const header = `Траты на связь за период ${result.range.from} — ${result.range.to}.`;
    const totalLine = `Итого: ${formatMoney(result.total, result.currency)}.`;
    if (result.rows.length === 0) {
      return `${header}\n\n${totalLine}\n\nНе нашёл оплат провайдерам связи по текущим правилам (МТС/Билайн/Ростелеком/Мегафон/Tele2/Yota и др.).`;
    }
    const rows = result.rows.map((r, i) => {
      const examples = r.exampleMerchants.length > 0 ? ` (например: ${r.exampleMerchants.slice(0, 3).join(', ')})` : '';
      return `${i + 1}. ${r.provider}: ${formatMoney(r.total, result.currency)} (операций: ${r.count})${examples}`;
    }).join('\n');
    return [header, totalLine, rows].join('\n\n');
  }

  if (result.type === 'totalExpense') {
    const header = `Сумма трат за период ${result.range.from} — ${result.range.to}.`;
    const totalLine = `Итого расходов: ${formatMoney(result.totalExpense, result.currency)} (операций: ${result.count}).`;
    return [header, totalLine].join('\n\n');
  }

  if (result.type === 'largestExpense') {
    const header = `Самая большая покупка за период ${result.range.from} — ${result.range.to}.`;
    if (!result.row) return `${header}\n\nНе нашёл расходов в этом периоде.`;
    return [
      header,
      `${result.row.date} — ${result.row.merchant}`,
      `Категория: ${result.row.category}`,
      `Сумма: ${formatMoney(result.row.amount, result.currency)}`,
    ].join('\n');
  }

  if (result.type === 'spendByCategory') {
    const header = `Траты по категориям за период ${result.range.from} — ${result.range.to}.`;
    const totalLine = `Итого расходов: ${formatMoney(result.totalExpense, result.currency)}.`;
    const rows = result.rows.map((r, i) => {
      const share = pct(r.total, result.totalExpense);
      return `${i + 1}. ${r.category}: ${formatMoney(r.total, result.currency)} (${share}, операций: ${r.count})`;
    }).join('\n');
    return [header, totalLine, rows].filter(Boolean).join('\n\n');
  }

  if (result.type === 'topMerchants') {
    const header = `Топ мест по тратам за период ${result.range.from} — ${result.range.to}.`;
    const totalLine = `Итого расходов: ${formatMoney(result.totalExpense, result.currency)}.`;
    const rows = result.rows.map((r, i) => {
      const share = pct(r.total, result.totalExpense);
      const cat = r.categoryTop ? `, чаще всего: ${r.categoryTop}` : '';
      return `${i + 1}. ${r.merchant}: ${formatMoney(r.total, result.currency)} (${share}, ${r.count}×, средний чек ${formatMoney(r.avg, result.currency)}${cat})`;
    }).join('\n');
    return [header, totalLine, rows].filter(Boolean).join('\n\n');
  }

  if (result.type === 'cashflowByMonth') {
    const header = `Кэшфлоу по месяцам за период ${result.range.from} — ${result.range.to}.`;
    const rows = result.rows.map((r) => {
      return `${r.month}: доход ${formatMoney(r.income, result.currency)}, расход ${formatMoney(r.expense, result.currency)}, нетто ${formatMoney(r.net, result.currency)}`;
    }).join('\n');
    return [header, rows].filter(Boolean).join('\n\n');
  }

  const header = `Аномальные траты за период ${result.range.from} — ${result.range.to} (группировка: ${result.groupBy === 'merchant' ? 'мерчант' : 'категория'}).`;
  if (result.rows.length === 0) {
    return `${header}\n\nНе нашёл сильных отклонений по текущему порогу.`;
  }
  const rows = result.rows.map((r, i) => {
    const ratio = `${(Math.round(r.ratio * 10) / 10).toLocaleString('ru-RU')}×`;
    return `${i + 1}. ${r.key}: ${formatMoney(r.periodTotal, result.currency)} (обычно ~${formatMoney(r.baselineAvg, result.currency)} в месяц, отклонение ${ratio})`;
  }).join('\n');
  return [header, rows].join('\n\n');
}

