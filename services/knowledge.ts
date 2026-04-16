import knowledge from '../knowledge/mtsdengi-knowledge.json';

export interface KnowledgeChunk {
  type: 'product' | 'faq' | 'premium' | 'contact';
  title: string;
  content: string;
  url?: string;
  score: number;
}

type KnowledgeEntry = {
  keywords?: string[];
  name?: string;
  question?: string;
  [key: string]: unknown;
};

// Tokenize a string into lowercase words
function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^а-яёa-z0-9\s]/gi, ' ').split(/\s+/).filter(Boolean);
}

// Score how well a query matches an entry's keywords and text fields
function scoreEntry(queryTokens: string[], entry: KnowledgeEntry): number {
  const keywords: string[] = entry.keywords ?? [];
  const nameText = String(entry.name ?? entry.question ?? '').toLowerCase();
  const keywordText = keywords.join(' ').toLowerCase();
  const fullText = (nameText + ' ' + keywordText).toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    if (token.length < 2) continue;
    if (keywords.some(k => k.toLowerCase().includes(token))) score += 3;
    else if (fullText.includes(token)) score += 1;
  }
  return score;
}

export function retrieveContext(query: string, topK = 5): KnowledgeChunk[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const results: KnowledgeChunk[] = [];

  // Always include login info for auth-related queries
  const authKeywords = ['войти', 'вход', 'логин', 'авториз', 'личный кабинет', 'зайти'];
  const isAuthQuery = tokens.some(t => authKeywords.some(k => t.includes(k)));
  if (isAuthQuery) {
    results.push({
      type: 'faq',
      title: 'Вход в личный кабинет',
      content: `Вход в ЛК МТС Деньги: сайт online.mtsdengi.ru. Авторизация по номеру телефона + SMS-код. Приложение: МТС Деньги (App Store, Google Play).`,
      url: knowledge.online_cabinet.base_url,
      score: 10,
    });
  }

  // Score products
  for (const product of knowledge.products) {
    const score = scoreEntry(tokens, product as KnowledgeEntry);
    if (score > 0) {
      results.push({
        type: 'product',
        title: product.name,
        content: `${product.summary}\n${product.details}`,
        url: product.url,
        score,
      });
    }
  }

  // Score premium separately
  const premiumScore = scoreEntry(tokens, knowledge.premium as KnowledgeEntry);
  if (premiumScore > 0) {
    results.push({
      type: 'premium',
      title: knowledge.premium.name,
      content: `${knowledge.premium.summary}\n${knowledge.premium.details}`,
      url: knowledge.premium.url,
      score: premiumScore,
    });
  }

  // Score FAQ
  for (const faq of knowledge.faq) {
    const score = scoreEntry(tokens, faq as KnowledgeEntry);
    if (score > 0) {
      results.push({
        type: 'faq',
        title: faq.question,
        content: `Вопрос: ${faq.question}\nОтвет: ${faq.answer}`,
        score,
      });
    }
  }

  // Score contacts for support/office queries
  const contactKeywords = ['офис', 'поддержка', 'телефон', 'контакт', 'адрес', 'горячая линия'];
  const isContactQuery = tokens.some(t => contactKeywords.some(k => t.includes(k)));
  if (isContactQuery) {
    results.push({
      type: 'contact',
      title: 'Контакты МТС Деньги',
      content: `Поддержка: ${knowledge.contacts.support_url}\nОфисы и банкоматы: ${knowledge.contacts.offices_url}\nЮридический адрес: ${knowledge.contacts.legal_address}\nСоциальные сети: ${knowledge.contacts.social.join(', ')}`,
      url: knowledge.contacts.offices_url,
      score: 5,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

// Format retrieved chunks as a compact string for injection into LLM prompt
export function formatContextForPrompt(chunks: KnowledgeChunk[]): string {
  if (chunks.length === 0) return '';
  return '## Контекст из базы знаний МТС Деньги:\n' +
    chunks.map(c => `[${c.title}]\n${c.content}`).join('\n\n');
}
