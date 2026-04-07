import { DOMElement } from '../components/WebViewAgent';
import { SYSTEM_PROMPT } from '../constants/prompts';
import { retrieveContext, formatContextForPrompt } from './knowledge';

const BASE_URL = process.env.EXPO_PUBLIC_LLM_BASE_URL ?? 'http://localhost:11434/v1';
const API_KEY = process.env.EXPO_PUBLIC_LLM_API_KEY ?? 'ollama';
const MODEL = process.env.EXPO_PUBLIC_LLM_MODEL ?? 'llama3.2';
const TIMEOUT_MS = 60_000;

// Log config once on startup so it's visible in Metro logs
console.log('[LLM] Config →', { url: BASE_URL, model: MODEL, keySet: API_KEY !== 'ollama' });

function wrapNetworkError(err: unknown, url: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Network request failed') || msg.includes('timed out') || msg.includes('Failed to fetch')) {
    return new Error(
      `Не удалось подключиться к LLM (${BASE_URL}).\n` +
      `Проверьте:\n• Сервер запущен?\n• EXPO_PUBLIC_LLM_BASE_URL в .env.local верный?\n• Доступен ли ${url} из симулятора?`
    );
  }
  if (msg.includes('AbortError') || msg.includes('aborted')) {
    return new Error(`LLM не ответил за ${TIMEOUT_MS / 1000}с. Сервер перегружен или URL неверный: ${BASE_URL}`);
  }
  return err instanceof Error ? err : new Error(msg);
}

const CLASSIFY_PROMPT = `Ты классификатор для ассистента клиник МЕДСИ.

Архитектура: smartmed.pro — запись, личный кабинет. medsi.ru — справочный сайт (читается из базы знаний, браузер не нужен).

Определи тип запроса:
- "action": нужно что-то СДЕЛАТЬ в SmartMed — записаться к врачу, выбрать время, найти врача, нажать кнопку
- "read": нужно ПРОЧИТАТЬ и показать данные из SmartMed — уведомления, анализы, результаты, документы, записи, назначения, направления, медкарта
- "chat": справочный вопрос — адрес клиники, специальности, цены, часы работы, что такое МЕДСИ — отвечай из базы знаний

Примеры "action": "запишись к врачу", "забронируй время", "открой медкарту", "перейди в раздел".
Примеры "read": "покажи уведомления", "что в моих анализах", "какие у меня назначения", "покажи мои документы", "последние записи", "результаты анализов".
Примеры "chat": "где находится клиника", "какие врачи есть", "сколько стоит", "как записаться".

ВАЖНО: chat-ответы пиши обычным текстом БЕЗ markdown — никаких **, ##, |, ---. Только текст и переносы строк.

Ответь ТОЛЬКО валидным JSON (без markdown):
{"type": "action"}
или
{"type": "read"}
или
{"type": "chat", "response": "ответ обычным текстом без markdown"}`;

export type Classification =
  | { type: 'action' }
  | { type: 'read' }
  | { type: 'chat'; response: string };

export async function classifyMessage(text: string): Promise<Classification> {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Retrieve relevant context to help with classification and direct answers
  const chunks = retrieveContext(text, 4);
  const contextBlock = formatContextForPrompt(chunks);
  const systemWithContext = contextBlock
    ? `${CLASSIFY_PROMPT}\n\n${contextBlock}`
    : CLASSIFY_PROMPT;

  const endpoint = `${BASE_URL}/chat/completions`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemWithContext },
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
  } catch (err) {
    throw wrapNetworkError(err, endpoint);
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
        if (el.autoId) parts.push(`autoId="${el.autoId}"`);
        if (el.sel) parts.push(`sel="${el.sel}"`);
        if (el.text) parts.push(`"${el.text}"`);
        if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
        if (el.type && el.type !== 'submit') parts.push(`type=${el.type}`);
        if (el.href) parts.push(`href="${el.href.substring(0, 60)}"`);
        return parts.join(' ');
      }).join('\n')
    : '(снапшот пуст — страница ещё загружается или нет интерактивных элементов)';

  // Retrieve relevant knowledge for this goal
  const chunks = retrieveContext(goal, 4);
  const contextBlock = formatContextForPrompt(chunks);

  const userMessage = `Цель: ${goal}

Текущий URL: ${currentUrl}${historyText}${contextBlock ? '\n\n' + contextBlock : ''}

DOM (интерактивные элементы):
${domText}`;

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const endpoint = `${BASE_URL}/chat/completions`;
  try {
    console.log('[LLM] generateAction →', endpoint, '| steps:', history.length);

    const response = await fetch(endpoint, {
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
    return parsed;
  } catch (err) {
    throw wrapNetworkError(err, endpoint);
  } finally {
    clearTimeout(timerId);
  }
}
