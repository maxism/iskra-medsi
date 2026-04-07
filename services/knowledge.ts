import knowledge from '../knowledge/medsi-knowledge.json';

export interface KnowledgeChunk {
  type: 'clinic' | 'specialty' | 'service' | 'faq' | 'booking' | 'program' | 'section';
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
    // Exact keyword match — high score
    if (keywords.some(k => k.toLowerCase().includes(token))) score += 3;
    // Partial text match — lower score
    else if (fullText.includes(token)) score += 1;
  }
  return score;
}

function clinicToContent(clinic: typeof knowledge.clinics[number]): string {
  const parts: string[] = [`Клиника: ${clinic.name}`];
  if (clinic.address) parts.push(`Адрес: ${clinic.address}`);
  if (clinic.metro?.length) parts.push(`Метро: ${clinic.metro.join(', ')}`);
  if ('phone' in clinic && clinic.phone) parts.push(`Телефон: ${(clinic as { phone: string }).phone}`);
  if ('hours' in clinic && (clinic as { hours?: string }).hours) parts.push(`Часы работы: ${(clinic as { hours: string }).hours}`);
  if (clinic.booking_url) parts.push(`Запись: ${clinic.booking_url}`);
  if ('features' in clinic && Array.isArray((clinic as { features?: string[] }).features)) {
    parts.push(`Особенности: ${(clinic as { features: string[] }).features.join('; ')}`);
  }
  return parts.join('\n');
}

// Score SmartMed specialties against query
function scoreSmartMedSpecialties(queryTokens: string[]): KnowledgeChunk | null {
  const allSpecs = [
    ...(knowledge.smartmed.specialties_clinic ?? []),
    ...(knowledge.smartmed.specialties_online ?? []),
  ];
  const matched = allSpecs.filter(spec =>
    queryTokens.some(t => t.length > 2 && spec.toLowerCase().includes(t))
  );
  if (matched.length === 0) return null;
  const unique = [...new Set(matched)].slice(0, 8);
  return {
    type: 'specialty',
    title: 'Специализации SmartMed',
    content: `Доступные специализации для записи: ${unique.join(', ')}\nЗапись в клинику: ${knowledge.smartmed.navigation.appointment_clinic}\nОнлайн-консультация: ${knowledge.smartmed.navigation.online_consultation}`,
    url: knowledge.smartmed.navigation.appointment_clinic,
    score: 4,
  };
}

export function retrieveContext(query: string, topK = 5): KnowledgeChunk[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const results: KnowledgeChunk[] = [];

  // Always include booking info for action queries
  const bookingKeywords = ['запис', 'прием', 'приём', 'бронир', 'appointment', 'book'];
  const isBookingQuery = tokens.some(t => bookingKeywords.some(k => t.includes(k)));
  if (isBookingQuery) {
    results.push({
      type: 'booking',
      title: 'Запись к врачу',
      content: `Запись к врачу: нажать кнопку «Записаться на прием» или перейти на ${knowledge.booking.url_general}\nШаги: ${knowledge.booking.smartmed_login_flow.join(' → ')}\nТелефон: ${knowledge.booking.phone}`,
      url: knowledge.booking.url_general,
      score: 10,
    });
  }

  // Score clinics
  for (const clinic of knowledge.clinics) {
    const score = scoreEntry(tokens, clinic as KnowledgeEntry);
    if (score > 0) {
      results.push({
        type: 'clinic',
        title: clinic.name,
        content: clinicToContent(clinic),
        url: clinic.page_url ?? clinic.booking_url,
        score,
      });
    }
  }

  // Score specialties
  for (const spec of knowledge.specialties) {
    const score = scoreEntry(tokens, spec as KnowledgeEntry);
    if (score > 0) {
      results.push({
        type: 'specialty',
        title: spec.name,
        content: `Специальность: ${spec.name}\nПоиск врачей: ${spec.search_url}`,
        url: spec.search_url,
        score,
      });
    }
  }

  // Score services
  for (const svc of knowledge.services) {
    const score = scoreEntry(tokens, svc as KnowledgeEntry);
    if (score > 0) {
      results.push({
        type: 'service',
        title: svc.name,
        content: `Услуга: ${svc.name}\nСсылка: ${svc.search_url}`,
        url: svc.search_url,
        score,
      });
    }
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

  // Score programs
  for (const prog of knowledge.programs) {
    const score = scoreEntry(tokens, prog as KnowledgeEntry);
    if (score > 0) {
      results.push({
        type: 'program',
        title: prog.name,
        content: `Программа: ${prog.name} — ${prog.description}\nСсылка: ${prog.url}`,
        url: prog.url,
        score,
      });
    }
  }

  // Score special sections
  for (const section of knowledge.special_sections) {
    const score = scoreEntry(tokens, section as KnowledgeEntry);
    if (score > 0) {
      results.push({
        type: 'section',
        title: section.name,
        content: `Раздел: ${section.name}\nСсылка: ${section.url}`,
        url: section.url,
        score,
      });
    }
  }

  // Score SmartMed specialties
  const smartmedChunk = scoreSmartMedSpecialties(tokens);
  if (smartmedChunk) results.push(smartmedChunk);

  // Include SmartMed navigation context for booking queries
  if (isBookingQuery) {
    results.push({
      type: 'section',
      title: 'SmartMed — навигация',
      content: `SmartMed разделы:\n- Запись в клинику: ${knowledge.smartmed.navigation.appointment_clinic}\n- Онлайн-консультация: ${knowledge.smartmed.navigation.online_consultation}\n- Список клиник: ${knowledge.smartmed.base_url}${knowledge.smartmed.navigation.clinics}\n- Врачи: ${knowledge.smartmed.base_url}${knowledge.smartmed.navigation.doctors}\n- Медкарта: ${knowledge.smartmed.base_url}${knowledge.smartmed.navigation.medical_card}`,
      url: knowledge.smartmed.navigation.appointment_clinic,
      score: 8,
    });
  }

  // Sort by score descending, take topK
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

// Format retrieved chunks as a compact string for injection into LLM prompt
export function formatContextForPrompt(chunks: KnowledgeChunk[]): string {
  if (chunks.length === 0) return '';
  return '## Контекст из базы знаний МЕДСИ:\n' +
    chunks.map(c => `[${c.title}]\n${c.content}`).join('\n\n');
}
