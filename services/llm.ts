import { DOMElement } from '../components/WebViewAgent';
import { SYSTEM_PROMPT, CLASSIFY_PROMPT } from '../constants/prompts';
import { retrieveContext, formatContextForPrompt } from './knowledge';

// ── Provider detection ──────────────────────────────────────────────────────
// If EXPO_PUBLIC_OPENROUTER_API_KEY is set, OpenRouter is used automatically.
// Otherwise falls back to the local Ollama config.

const OPENROUTER_KEY = process.env.EXPO_PUBLIC_OPENROUTER_API_KEY ?? '';
const IS_OPENROUTER = OPENROUTER_KEY.length > 0;

const BASE_URL = IS_OPENROUTER
  ? 'https://openrouter.ai/api/v1'
  : (process.env.EXPO_PUBLIC_LLM_BASE_URL ?? 'http://localhost:11434/v1');

const API_KEY = IS_OPENROUTER
  ? OPENROUTER_KEY
  : (process.env.EXPO_PUBLIC_LLM_API_KEY ?? 'ollama');

const MODEL = IS_OPENROUTER
  ? (process.env.EXPO_PUBLIC_OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4-6')
  : (process.env.EXPO_PUBLIC_LLM_MODEL ?? 'llama3.2');

// ── Timeouts ─────────────────────────────────────────────────────────────────
// OpenRouter responds quickly (no cold start). Ollama needs a long cold start.
const TIMEOUT_WARM_MS = IS_OPENROUTER ? 30_000 : 60_000;
const TIMEOUT_COLD_MS = IS_OPENROUTER ? 30_000 : 150_000;

/** True once the first successful LLM response completes for this session. */
export let isWarmedUp = false;

function getTimeout(): number {
  return isWarmedUp ? TIMEOUT_WARM_MS : TIMEOUT_COLD_MS;
}

// Log config once on startup so it's visible in Metro logs
console.log('[LLM] Config →', {
  provider: IS_OPENROUTER ? 'openrouter' : 'local',
  url: BASE_URL,
  model: MODEL,
  keySet: API_KEY !== 'ollama',
});

/** Returns the request headers for the active provider. */
function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEY}`,
  };
  if (IS_OPENROUTER) {
    // Recommended by OpenRouter for attribution / rate-limit tiers
    headers['HTTP-Referer'] = 'https://mtsdengi.ru';
    headers['X-Title'] = 'Iskra-MTSMoney';
  }
  return headers;
}

/**
 * Returns a one-line date context injected at the top of every system prompt.
 * The model has a training cutoff and doesn't know the real date — we tell it explicitly.
 */
function buildDateContext(): string {
  const now = new Date();
  const formatted = now.toLocaleDateString('ru-RU', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return `Сегодня: ${formatted}. Текущий год: ${now.getFullYear()}.`;
}

function wrapNetworkError(err: unknown, url: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Network request failed') || msg.includes('timed out') || msg.includes('Failed to fetch')) {
    return new Error(
      `Не удалось подключиться к LLM (${BASE_URL}).\n` +
      `Проверьте:\n• Сервер запущен?\n• EXPO_PUBLIC_LLM_BASE_URL в .env.local верный?\n• Доступен ли ${url} из симулятора?`
    );
  }
  if (msg.includes('AbortError') || msg.includes('aborted')) {
    const limit = getTimeout() / 1000;
    return new Error(
      `LLM не ответил за ${limit}с.\n` +
      `Попробуйте ещё раз — сервер мог перезагружаться.`
    );
  }
  return err instanceof Error ? err : new Error(msg);
}


export type Classification =
  | { type: 'action' }
  | { type: 'read' }
  | { type: 'chat'; response: string };

export async function classifyMessage(text: string): Promise<Classification> {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), getTimeout());

  // Retrieve relevant context to help with classification and direct answers
  const chunks = retrieveContext(text, 4);
  const contextBlock = formatContextForPrompt(chunks);
  const systemWithContext = [
    buildDateContext(),
    CLASSIFY_PROMPT,
    contextBlock,
  ].filter(Boolean).join('\n\n');

  const endpoint = `${BASE_URL}/chat/completions`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: buildHeaders(),
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
    const result = JSON.parse(cleaned) as Classification;
    isWarmedUp = true; // model responded — mark as warm for this session
    return result;
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
  /** Value returned via window.__agentResult — shown to LLM so it knows what was read */
  value?: string;
}

export async function generateAction(
  goal: string,
  domSnapshot: DOMElement[],
  currentUrl: string,
  history: StepHistory[] = [],
): Promise<AgentAction> {
  const historyText = history.length > 0
    ? `\nИстория шагов:\n${history.map((h) => {
        const status = h.success ? '✓' : `✗ ошибка: ${h.error ?? 'неизвестно'}`;
        // Show even empty results so the LLM knows extraction ran but found nothing
        const valueLine = h.value != null
          ? `\n   результат: ${h.value.length > 0 ? h.value : '(пусто — элемент не найден на странице)'}`
          : '';
        return `${h.step}. [${h.url}] ${h.description} — ${status}\n   код: ${h.code}${valueLine}`;
      }).join('\n')}`
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
  const timerId = setTimeout(() => controller.abort(), getTimeout());

  const endpoint = `${BASE_URL}/chat/completions`;
  try {
    console.log('[LLM] generateAction →', endpoint, '| steps:', history.length);

    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: buildHeaders(),
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: `${buildDateContext()}\n\n${SYSTEM_PROMPT}` },
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
    console.log('[LLM] generateAction raw:', raw.substring(0, 500));

    // Strip markdown code fences if present
    let cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    // If there is text before/after the JSON object, extract just the object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];

    let parsed: { description: string; code: string; done: boolean };
    try {
      parsed = JSON.parse(cleaned) as typeof parsed;
    } catch (parseErr) {
      console.error('[LLM] JSON parse failed. Raw was:', raw);
      throw new Error(`LLM вернул невалидный JSON: ${raw.substring(0, 200)}`);
    }

    // Normalise: ensure required fields exist
    if (!parsed.description) parsed.description = 'Выполняю действие…';
    if (parsed.code == null) parsed.code = '';
    if (typeof parsed.done !== 'boolean') parsed.done = false;

    return parsed;
  } catch (err) {
    throw wrapNetworkError(err, endpoint);
  } finally {
    clearTimeout(timerId);
  }
}
