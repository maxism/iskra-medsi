import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useCallback,
} from 'react';
import { StyleSheet } from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';

export interface WebViewMessage {
  type: 'result' | 'domSnapshot' | 'log';
  requestId?: string;
  success?: boolean;
  error?: string;
  snapshot?: DOMElement[];
  message?: string;
}

export interface DOMElement {
  tag: string;
  text?: string;
  id?: string;
  class?: string;
  placeholder?: string;
  type?: string;
  href?: string;
  name?: string;
}

export interface WebViewAgentRef {
  injectJS: (code: string, requestId?: string) => void;
  captureDOM: (requestId: string) => void;
  reload: () => void;
  onMessage: (handler: (msg: WebViewMessage) => void) => void;
}

interface Props {
  onNavigationStateChange?: (url: string) => void;
}

const BOOTSTRAP_SCRIPT = `
(function() {
  if (window.__agentBootstrapped) return;
  window.__agentBootstrapped = true;

  window.addEventListener('message', function(event) {
    try {
      var data = JSON.parse(event.data);
      if (data.type === 'execute' && data.code) {
        try {
          eval(data.code);
        } catch (e) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'result',
            requestId: data.requestId,
            success: false,
            error: e.message
          }));
        }
      } else if (data.type === 'captureDOM') {
        var requestId = data.requestId;
        var selectors = 'button, input, a, select, textarea, [role="button"], [onclick]';
        var elements = Array.from(document.querySelectorAll(selectors));
        var snapshot = elements.slice(0, 50).map(function(el) {
          var rect = el.getBoundingClientRect();
          var visible = rect.width > 0 && rect.height > 0;
          if (!visible) return null;
          return {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || el.innerText || '').trim().substring(0, 100),
            id: el.id || undefined,
            class: el.className || undefined,
            placeholder: el.placeholder || undefined,
            type: el.type || undefined,
            href: el.href || undefined,
            name: el.name || undefined,
          };
        }).filter(Boolean);
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'domSnapshot',
          requestId: requestId,
          snapshot: snapshot
        }));
      }
    } catch (e) {}
  });

  true;
})();
`;

const WebViewAgent = forwardRef<WebViewAgentRef, Props>(
  ({ onNavigationStateChange }, ref) => {
    const webViewRef = useRef<WebView>(null);
    const messageHandlerRef = useRef<((msg: WebViewMessage) => void) | null>(null);

    const injectJS = useCallback((code: string, requestId?: string) => {
      const wrappedCode = `
        (function() {
          try {
            ${code}
          } catch(e) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'result',
              requestId: ${JSON.stringify(requestId ?? null)},
              success: false,
              error: e.message
            }));
          }
        })();
        true;
      `;
      webViewRef.current?.injectJavaScript(wrappedCode);
    }, []);

    const captureDOM = useCallback((requestId: string) => {
      const code = `
        (function() {
          window.postMessage(JSON.stringify({
            type: 'captureDOM',
            requestId: ${JSON.stringify(requestId)}
          }), '*');
        })();
        true;
      `;
      webViewRef.current?.injectJavaScript(code);
    }, []);

    const reload = useCallback(() => {
      webViewRef.current?.reload();
    }, []);

    const onMessage = useCallback((handler: (msg: WebViewMessage) => void) => {
      messageHandlerRef.current = handler;
    }, []);

    useImperativeHandle(ref, () => ({
      injectJS,
      captureDOM,
      reload,
      onMessage,
    }));

    const handleMessage = useCallback((event: WebViewMessageEvent) => {
      try {
        const data: WebViewMessage = JSON.parse(event.nativeEvent.data);
        messageHandlerRef.current?.(data);
      } catch (e) {
        // ignore non-JSON messages
      }
    }, []);

    return (
      <WebView
        ref={webViewRef}
        source={{ uri: 'https://medsi.ru' }}
        style={styles.webview}
        injectedJavaScriptBeforeContentLoaded={BOOTSTRAP_SCRIPT}
        injectedJavaScript={BOOTSTRAP_SCRIPT}
        onMessage={handleMessage}
        onNavigationStateChange={(navState) => {
          if (navState.url) {
            onNavigationStateChange?.(navState.url);
          }
        }}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="always"
        originWhitelist={['*']}
      />
    );
  },
);

WebViewAgent.displayName = 'WebViewAgent';

const styles = StyleSheet.create({
  webview: {
    flex: 1,
  },
});

export default WebViewAgent;
