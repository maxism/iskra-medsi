import { DOMElement } from '../components/WebViewAgent';
import { SYSTEM_PROMPT } from '../constants/prompts';

const BASE_URL = process.env.EXPO_PUBLIC_LLM_BASE_URL ?? 'http://localhost:11434/v1';
const API_KEY = process.env.EXPO_PUBLIC_LLM_API_KEY ?? 'ollama';
const MODEL = process.env.EXPO_PUBLIC_LLM_MODEL ?? 'llama3.2';
const TIMEOUT_MS = 120_000;

const CLASSIFY_PROMPT = `Ты классификатор для ассистента медицинской клиники МЕДСИ (medsi.ru).

Определи тип запроса пользователя:
- "action": нужно что-то сделать на сайте — найти клинику, записаться к врачу, заполнить форму, перейти на страницу, найти информацию через навигацию
- "chat": общий вопрос, приветствие, вопрос о компании/услугах на который можно ответить без браузера

Ответь ТОЛЬКО валидным JSON (без markdown):
{"type": "action"}
или
{"type": "chat", "response": "ответ на языке пользователя"}`;

export type Classification =
  | { type: 'action' }
  | { type: 'chat'; response: string };

export async function classifyMessage(text: string): Promise<Classification> {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: CLASSIFY_PROMPT },
          { role: 'user', content: text },
        ],
        max_tokens: 512,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM API error ${response.status}: ${body}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const raw = (data.choices?.[0]?.message?.content ?? '').trim();
    console.log('[LLM] Classification response:', raw);
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    return JSON.parse(cleaned) as Classification;
  } finally {
    clearTimeout(timerId);
  }
}

export interface AgentAction {
  description: string;
  code: string;
  done: boolean;
}

export interface StepHistory {
  step: number;
  url: string;
  description: string;
  code: string;
  success: boolean;
  error?: string;
}

export async function generateAction(
  goal: string,
  domSnapshot: DOMElement[],
  currentUrl: string,
  history: StepHistory[] = [],
): Promise<AgentAction> {
  const historyText = history.length > 0
    ? `\nИстория шагов:\n${history.map((h) =>
        `${h.step}. [${h.url}] ${h.description} — ${h.success ? '✓' : `✗ ошибка: ${h.error ?? 'неизвестно'}`}\n   код: ${h.code}`
      ).join('\n')}`
    : '';

  // Compact DOM: one line per element
  const domText = domSnapshot.length > 0
    ? domSnapshot.map((el, i) => {
        const parts: string[] = [`[${i}]<${el.tag}>`];
        if (el.sel) parts.push(`sel="${el.sel}"`);
        if (el.text) parts.push(`"${el.text}"`);
        if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
        if (el.type && el.type !== 'submit') parts.push(`type=${el.type}`);
        if (el.href) parts.push(`href="${el.href.substring(0, 60)}"`);
        return parts.join(' ');
      }).join('\n')
    : '(снапшот пуст — страница ещё загружается или нет интерактивных элементов)';

  const userMessage = `Цель: ${goal}

Текущий URL: ${currentUrl}${historyText}

DOM (интерактивные элементы):
${domText}`;

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    console.log('[LLM] Request URL:', currentUrl, '| History steps:', history.length);

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 2048,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM API error ${response.status}: ${body}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const raw = (data.choices?.[0]?.message?.content ?? '').trim();
    const cleaned = raw
      .replace(/^```(?:json)?\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();

    console.log('[LLM] Raw response:', raw);
    const parsed = JSON.parse(cleaned) as { description: string; code: string; done: boolean };
    console.log('[LLM] Parsed action:', JSON.stringify(parsed, null, 2));
    return parsed;
  } finally {
    clearTimeout(timerId);
  }
}
