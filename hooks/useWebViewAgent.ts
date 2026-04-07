import { useCallback, useEffect, useRef, useState } from 'react';
import { RefObject } from 'react';
import { WebViewAgentRef, WebViewMessage, DOMElement } from '../components/WebViewAgent';
import { Message, MessageRole } from '../components/ChatMessage';
import { classifyMessage, generateAction, StepHistory, isWarmedUp } from '../services/llm';

const MAX_STEPS = 20;
const PAGE_LOAD_WAIT_MS = 2000;
const MAX_CONSECUTIVE_ERRORS = 3;

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function makeMessage(role: MessageRole, text: string): Message {
  return { id: makeId(), role, text, timestamp: Date.now() };
}

type PendingRequest = {
  resolve: (value: WebViewMessage) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export function useWebViewAgent(
  webViewRef: RefObject<WebViewAgentRef>,
  currentUrl: string,
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const pendingRef = useRef<Map<string, PendingRequest>>(new Map());
  const currentUrlRef = useRef(currentUrl);

  useEffect(() => {
    currentUrlRef.current = currentUrl;
  }, [currentUrl]);

  const addMessage = useCallback((role: MessageRole, text: string) => {
    setMessages((prev) => [...prev, makeMessage(role, text)]);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  useEffect(() => {
    const ref = webViewRef.current;
    if (!ref) return;

    ref.onMessage((msg: WebViewMessage) => {
      const requestId = msg.requestId;
      if (!requestId) return;

      const pending = pendingRef.current.get(requestId);
      if (pending) {
        clearTimeout(pending.timeoutId);
        pendingRef.current.delete(requestId);
        pending.resolve(msg);
      }
    });
  }, [webViewRef]);

  const waitForMessage = useCallback(
    (requestId: string, timeoutMs = 8000): Promise<WebViewMessage> => {
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pendingRef.current.delete(requestId);
          reject(new Error('Timeout waiting for WebView response'));
        }, timeoutMs);

        pendingRef.current.set(requestId, { resolve, reject, timeoutId });
      });
    },
    [],
  );

  const captureDOM = useCallback(async (): Promise<DOMElement[]> => {
    const requestId = makeId();
    webViewRef.current?.captureDOM(requestId);
    const msg = await waitForMessage(requestId, 8000);
    return msg.snapshot ?? [];
  }, [webViewRef, waitForMessage]);

  const executeJS = useCallback(
    async (code: string): Promise<{ success: boolean; error?: string }> => {
      // Each execution gets its own requestId — not tied to LLM generation
      const requestId = makeId();
      webViewRef.current?.injectJS(code, requestId);
      try {
        const msg = await waitForMessage(requestId, 8000);
        return { success: msg.success ?? false, error: msg.error };
      } catch {
        return { success: false, error: 'Execution timeout' };
      }
    },
    [webViewRef, waitForMessage],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      if (isLoading) return;

      addMessage('user', text);
      setIsLoading(true);

      // Warn user about potential cold-start delay on first request per session
      if (!isWarmedUp) {
        addMessage('agent', 'Инициализация модели… первый запрос может занять до 2 минут.');
      }

      const history: StepHistory[] = [];
      let consecutiveErrors = 0;
      let completed = false;

      try {
        // Classify: chat vs action vs read
        try {
          const classification = await classifyMessage(text);
          if (classification.type === 'chat') {
            addMessage('agent', classification.response);
            return;
          }
          // 'action' and 'read' both go through the browser agent loop
          // 'read' means navigate + extract text; agent returns content in done:true description
        } catch {
          // Classification failed — treat as action
        }

        for (let step = 0; step < MAX_STEPS; step++) {
          // Capture DOM snapshot
          let domSnapshot: DOMElement[] = [];
          try {
            domSnapshot = await captureDOM();
          } catch {
            // proceed with empty snapshot
          }

          // Ask LLM for next action
          const action = await generateAction(
            text,
            domSnapshot,
            currentUrlRef.current,
            history,
          );

          addMessage('agent', action.description);

          if (action.done) {
            completed = true;
            break;
          }

          // Loop detection: same code on same URL as previous step
          const lastStep = history[history.length - 1];
          if (
            lastStep &&
            lastStep.code === action.code &&
            lastStep.url === currentUrlRef.current
          ) {
            addMessage('error', 'Агент повторяет одно и то же действие. Попробуйте переформулировать задачу.');
            break;
          }

          // Execute the action (requestId is internal, LLM doesn't see it)
          const result = await executeJS(action.code);

          history.push({
            step: step + 1,
            url: currentUrlRef.current,
            description: action.description,
            code: action.code,
            success: result.success,
            error: result.error,
          });

          if (!result.success) {
            consecutiveErrors++;
            addMessage('error', `Шаг ${step + 1}: ${result.error ?? 'неизвестная ошибка'}`);
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              addMessage('error', 'Слишком много ошибок подряд. Попробуйте переформулировать задачу или обновить страницу.');
              break;
            }
            // Don't wait after error — LLM will try a different approach
            continue;
          } else {
            consecutiveErrors = 0;
          }

          // Wait for page to settle after successful action
          await new Promise<void>((r) => setTimeout(r, PAGE_LOAD_WAIT_MS));
        }

        // Notify user if max steps reached without completion
        if (!completed && history.length > 0 && consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
          addMessage('agent', 'Достигнут лимит шагов. Задача может быть не завершена — попробуйте продолжить или уточнить запрос.');
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        addMessage('error', `Ошибка: ${errorMsg}`);
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, addMessage, captureDOM, executeJS],
  );

  return { messages, isLoading, sendMessage, clearMessages };
}
