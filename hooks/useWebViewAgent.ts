import { useCallback, useEffect, useRef, useState } from 'react';
import { RefObject } from 'react';
import { WebViewAgentRef, WebViewMessage, DOMElement } from '../components/WebViewAgent';
import { Message, MessageRole } from '../components/ChatMessage';
import { classifyMessage, generateAction, StepHistory, isWarmedUp } from '../services/llm';

const MAX_STEPS = 20;
const PAGE_LOAD_WAIT_MS = 2000;
const MAX_CONSECUTIVE_ERRORS = 3;
// How many times the agent may execute identical code on the same URL before we call it a loop.
// 1 means "stop on first repeat"; 2 means "allow one retry of the same action".
const MAX_LOOP_REPEATS = 2;

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

  // Stable handler — pendingRef is a ref so no dep needed
  const messageHandler = useCallback((msg: WebViewMessage) => {
    const requestId = msg.requestId;
    if (!requestId) return;
    const pending = pendingRef.current.get(requestId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingRef.current.delete(requestId);
      pending.resolve(msg);
    }
  }, []);

  // Best-effort early registration (works when WebView is mounted on first render,
  // i.e. when there is no authReady gate or auth loads synchronously).
  useEffect(() => {
    webViewRef.current?.onMessage(messageHandler);
  }, [webViewRef, messageHandler]);

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
    const msg = await waitForMessage(requestId, 10000);
    return msg.snapshot ?? [];
  }, [webViewRef, waitForMessage]);

  const executeJS = useCallback(
    async (code: string): Promise<{ success: boolean; error?: string; value?: string }> => {
      const requestId = makeId();
      console.log('[Agent] executeJS start', requestId, 'codeLen:', code.length);
      webViewRef.current?.injectJS(code, requestId);
      try {
        const msg = await waitForMessage(requestId, 12000);
        console.log('[Agent] executeJS done', requestId, 'success:', msg.success, 'error:', msg.error);
        return { success: msg.success ?? false, error: msg.error, value: msg.value ?? undefined };
      } catch {
        console.error('[Agent] executeJS TIMEOUT', requestId);
        return { success: false, error: 'Execution timeout' };
      }
    },
    [webViewRef, waitForMessage],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      if (isLoading) return;

      // Re-register the message handler every time.
      // The WebView may have mounted after the initial useEffect ran
      // (e.g. when an authReady gate delays WebView rendering), so
      // messageHandlerRef.current could still be null from the effect.
      webViewRef.current?.onMessage(messageHandler);

      addMessage('user', text);
      setIsLoading(true);

      // Warn user about potential cold-start delay on first request per session
      if (!isWarmedUp) {
        addMessage('agent', 'Инициализация модели… первый запрос может занять до 2 минут.');
      }

      const history: StepHistory[] = [];
      let consecutiveErrors = 0;
      let completed = false;
      let stopReason = '';

      console.log(`[Agent ▶] goal="${text.substring(0, 80)}" | max=${MAX_STEPS} steps`);

      try {
        // Classify: chat vs action vs read
        try {
          const classification = await classifyMessage(text);
          console.log('[Agent] classification:', classification.type);
          if (classification.type === 'chat') {
            addMessage('agent', classification.response);
            return;
          }
        } catch {
          console.log('[Agent] classification failed — treating as action');
        }

        for (let step = 0; step < MAX_STEPS; step++) {
          const stepLabel = `[Step ${step + 1}/${MAX_STEPS}]`;

          // Wait for any in-progress page load before injecting anything.
          await webViewRef.current?.waitForPageLoad(6000);

          // Capture DOM snapshot
          let domSnapshot: DOMElement[] = [];
          try {
            domSnapshot = await captureDOM();
          } catch {
            // proceed with empty snapshot
          }
          console.log(`${stepLabel} url=${currentUrlRef.current} | dom=${domSnapshot.length} elements`);

          // Ask LLM for next action
          const action = await generateAction(
            text,
            domSnapshot,
            currentUrlRef.current,
            history,
          );

          const codePreview = action.code
            ? action.code.trim().split('\n')[0].substring(0, 100)
            : '(нет кода)';
          console.log(`${stepLabel} 🎯 ${action.description}`);
          if (!action.done) console.log(`${stepLabel} 📝 ${codePreview}`);

          addMessage('agent', action.description);

          if (action.done) {
            // If the final step includes code, execute it to capture
            // window.__agentResult as the actual answer content.
            if (action.code && action.code.trim()) {
              console.log(`${stepLabel} ⚙️ executing final code to capture result`);
              const finalResult = await executeJS(action.code);
              if (finalResult.success && finalResult.value && finalResult.value.trim()) {
                console.log(`${stepLabel} 📤 final value: "${finalResult.value.substring(0, 80)}"`);
                addMessage('agent', finalResult.value);
              }
            }
            completed = true;
            stopReason = 'done';
            console.log(`${stepLabel} ✅ STOP: agent declared done`);
            break;
          }

          // Guard: LLM returned done:false but no executable code
          if (!action.code || !action.code.trim()) {
            stopReason = 'no-code';
            console.log(`${stepLabel} ⛔ STOP: LLM returned no executable code`);
            addMessage('error', 'Агент не сформировал действие. Попробуйте переформулировать запрос.');
            break;
          }

          // Loop detection: count consecutive identical (code + url) attempts in history
          let loopCount = 0;
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].code === action.code && history[i].url === currentUrlRef.current) {
              loopCount++;
            } else {
              break;
            }
          }
          if (loopCount >= MAX_LOOP_REPEATS) {
            stopReason = 'loop';
            console.log(`${stepLabel} 🔁 STOP: loop — same code ran ${loopCount}× on this URL`);
            console.log(`${stepLabel}    repeated code: ${codePreview}`);
            addMessage('error', 'Агент повторяет одно и то же действие. Попробуйте переформулировать задачу.');
            break;
          }

          // Execute the action
          const result = await executeJS(action.code);

          history.push({
            step: step + 1,
            url: currentUrlRef.current,
            description: action.description,
            code: action.code,
            success: result.success,
            error: result.error,
            value: result.value,
          });

          if (!result.success) {
            consecutiveErrors++;
            console.log(`${stepLabel} ✗ error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${result.error}`);
            addMessage('error', `Шаг ${step + 1}: ${result.error ?? 'неизвестная ошибка'}`);
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              stopReason = 'max-errors';
              console.log(`${stepLabel} ⛔ STOP: ${MAX_CONSECUTIVE_ERRORS} consecutive errors`);
              addMessage('error', 'Слишком много ошибок подряд. Попробуйте переформулировать задачу или обновить страницу.');
              break;
            }
            continue;
          } else {
            consecutiveErrors = 0;
            const valPreview = result.value ? ` | value="${result.value.substring(0, 60)}"` : '';
            console.log(`${stepLabel} ✓ success${valPreview}`);
          }

          // Wait for page to settle after successful action
          await new Promise<void>((r) => setTimeout(r, PAGE_LOAD_WAIT_MS));
        }

        if (!completed && !stopReason) {
          stopReason = 'max-steps';
          console.log(`[Agent] ⛔ STOP: reached max steps (${MAX_STEPS})`);
        }
        console.log(`[Agent ■] finished | reason=${stopReason || 'done'} | steps=${history.length}`);

        if (!completed && history.length > 0 && consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
          addMessage('agent', 'Достигнут лимит шагов. Задача может быть не завершена — попробуйте продолжить или уточнить запрос.');
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.log(`[Agent] ⛔ STOP: exception — ${errorMsg}`);
        addMessage('error', `Ошибка: ${errorMsg}`);
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, addMessage, captureDOM, executeJS, messageHandler, webViewRef],
  );

  return { messages, isLoading, sendMessage, clearMessages };
}
