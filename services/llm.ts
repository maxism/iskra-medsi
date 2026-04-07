import { DOMElement } from '../components/WebViewAgent';
import { SYSTEM_PROMPT } from '../constants/prompts';

const BASE_URL = process.env.EXPO_PUBLIC_LLM_BASE_URL ?? 'http://localhost:11434/v1';
const API_KEY = process.env.EXPO_PUBLIC_LLM_API_KEY ?? 'ollama';
const MODEL = process.env.EXPO_PUBLIC_LLM_MODEL ?? 'llama3.2';
const TIMEOUT_MS = 120_000;

const CLASSIFY_PROMPT = `You are a classifier for a medical clinic website assistant (medsi.ru).

Determine if the user's message is:
- "action": requests to navigate, click, search, book, fill a form, find something on the website
- "chat": general questions, info about the company, greetings, or anything not requiring browser interaction

Respond with ONLY valid JSON (no markdown):
{"type": "action"}
or
{"type": "chat", "response": "your answer in the same language as the user's message"}`;

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
  requestId: string;
}

export interface StepHistory {
  description: string;
  success: boolean;
}

export async function generateAction(
  goal: string,
  domSnapshot: DOMElement[],
  currentUrl: string,
  requestId: string,
  history: StepHistory[] = [],
): Promise<AgentAction> {
  const historyText = history.length > 0
    ? `\nPrevious steps:\n${history.map((h, i) => `${i + 1}. ${h.description} — ${h.success ? 'success' : 'failed'}`).join('\n')}`
    : '';

  const userMessage = `Goal: ${goal}

Current URL: ${currentUrl}${historyText}

DOM Snapshot (interactive elements):
${JSON.stringify(domSnapshot, null, 2)}

Replace REQUEST_ID in your code with the string "${requestId}"`;

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    console.log('[LLM] Request:', JSON.stringify({
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT.slice(0, 200) + '...',
      userMessage,
    }, null, 2));

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
        max_tokens: 4096,
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
    return { ...parsed, requestId };
  } finally {
    clearTimeout(timerId);
  }
}
