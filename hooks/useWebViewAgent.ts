import { useCallback, useEffect, useRef, useState } from 'react';
import { RefObject } from 'react';
import { WebViewAgentRef, WebViewMessage, DOMElement } from '../components/WebViewAgent';
import { Message, MessageRole } from '../components/ChatMessage';
import { classifyMessage, generateAction, StepHistory } from '../services/llm';

const MAX_STEPS = 10;
const PAGE_LOAD_WAIT_MS = 2500;

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
    async (code: string, requestId: string): Promise<{ success: boolean; error?: string }> => {
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

      const history: StepHistory[] = [];

      try {
        try {
          const classification = await classifyMessage(text);
          if (classification.type === 'chat') {
            addMessage('agent', classification.response);
            return;
          }
        } catch {
          // if classification fails, treat as action
        }

        for (let step = 0; step < MAX_STEPS; step++) {
          // Capture current DOM
          let domSnapshot: DOMElement[] = [];
          try {
            domSnapshot = await captureDOM();
          } catch {
            // proceed with empty snapshot
          }

          // Ask LLM what to do next
          const requestId = makeId();
          const action = await generateAction(
            text,
            domSnapshot,
            currentUrlRef.current,
            requestId,
            history,
          );

          addMessage('agent', action.description);

          if (action.done) break;

          // Execute the action
          const result = await executeJS(action.code, requestId);
          history.push({ description: action.description, success: result.success });

          if (!result.success) {
            addMessage('error', `Ошибка на шаге ${step + 1}: ${result.error ?? 'неизвестная ошибка'}`);
            break;
          }

          // Wait for page to load after action
          await new Promise<void>((r) => setTimeout(r, PAGE_LOAD_WAIT_MS));
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
