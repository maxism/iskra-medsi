import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useCallback,
} from 'react';
import { StyleSheet } from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';

export interface WebViewMessage {
  type: 'result' | 'domSnapshot' | 'log' | 'authSnapshot';
  requestId?: string;
  success?: boolean;
  error?: string;
  snapshot?: DOMElement[];
  message?: string;
  /** Captured value of window.__agentResult set by agent code */
  value?: string;
  /** Auth snapshot fields (type === 'authSnapshot') */
  cookies?: string;
  localStorage?: Record<string, string>;
}

export interface DOMElement {
  tag: string;
  text?: string;
  id?: string;
  placeholder?: string;
  type?: string;
  href?: string;
  name?: string;
  sel?: string;    // unique CSS selector for targeting this element
  autoId?: string; // data-automation-id — stable SmartMed identifier
}

export interface WebViewAgentRef {
  injectJS: (code: string, requestId?: string) => void;
  captureDOM: (requestId: string) => void;
  captureAuth: () => void;
  reload: () => void;
  onMessage: (handler: (msg: WebViewMessage) => void) => void;
}

interface Props {
  onNavigationStateChange?: (url: string) => void;
  /** Pre-built script to restore localStorage + cookies — runs before page scripts */
  authRestoreScript?: string;
  /** Called whenever a captureAuth() snapshot arrives */
  onAuthSnapshot?: (cookies: string, ls: Record<string, string>) => void;
}

const BOOTSTRAP_SCRIPT = `
(function() {
  if (window.__agentBootstrapped) return;
  window.__agentBootstrapped = true;

  function getSelector(el) {
    if (el.id) return '#' + el.id;
    if (el.getAttribute('name')) return el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]';
    if (el.getAttribute('data-testid')) return '[data-testid="' + el.getAttribute('data-testid') + '"]';
    // Try first unique class
    var classes = (el.className || '').split(' ').map(function(c){ return c.trim(); }).filter(Boolean);
    for (var i = 0; i < classes.length; i++) {
      var sel = el.tagName.toLowerCase() + '.' + classes[i];
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch(e) {}
    }
    return null;
  }

  window.addEventListener('message', function(event) {
    try {
      var data = JSON.parse(event.data);
      if (data.type === 'captureAuth') {
        var ls = {};
        try {
          for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k) ls[k] = localStorage.getItem(k) || '';
          }
        } catch(lsErr) {}
        var cookies = '';
        try { cookies = document.cookie; } catch(cErr) {}
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'authSnapshot',
          cookies: cookies,
          localStorage: ls
        }));
      } else if (data.type === 'captureDOM') {
        var requestId = data.requestId;
        // Standard interactive + SmartMed-specific data-automation-id elements (clinic items, date slots are plain divs)
        var selectors = 'button, input, a, select, textarea, [role="button"], [onclick], [data-automation-id]';
        // Noise IDs to skip (icons, layout containers with no clickable meaning)
        var skipAutoIds = { 'smed-svg-icon': true, 'home-navbar': true, 'home-footer': true, 'new-appointment-page': true, 'smed-icon': true, 'smed-base-input-left-icon': true, 'smed-base-input-label': true, 'date-stepper-carousel': true };
        var elements = Array.from(document.querySelectorAll(selectors));
        var seen = {};
        var snapshot = [];
        for (var i = 0; i < elements.length && snapshot.length < 80; i++) {
          var el = elements[i];
          var autoId = el.getAttribute('data-automation-id') || '';
          if (autoId && skipAutoIds[autoId]) continue;
          var rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          var text = (el.textContent || el.innerText || '').trim().replace(/\\s+/g, ' ').substring(0, 80);
          var placeholder = el.placeholder || '';
          // Skip elements with no useful content
          if (!text && !placeholder && !el.id && !el.getAttribute('name') && !autoId) continue;
          // Deduplicate by text+autoId
          var key = el.tagName + '|' + text + '|' + placeholder + '|' + autoId;
          if (seen[key]) continue;
          seen[key] = true;
          var item = {
            tag: el.tagName.toLowerCase(),
          };
          if (text) item.text = text;
          if (el.id) item.id = el.id;
          if (placeholder) item.placeholder = placeholder;
          if (el.type) item.type = el.type;
          if (el.href) item.href = el.href.substring(0, 100);
          if (el.getAttribute('name')) item.name = el.getAttribute('name');
          if (autoId) item.autoId = autoId;
          var sel = getSelector(el);
          if (sel) item.sel = sel;
          snapshot.push(item);
        }
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
  ({ onNavigationStateChange, authRestoreScript, onAuthSnapshot }, ref) => {
    const webViewRef = useRef<WebView>(null);
    const messageHandlerRef = useRef<((msg: WebViewMessage) => void) | null>(null);
    const onAuthSnapshotRef = useRef(onAuthSnapshot);
    onAuthSnapshotRef.current = onAuthSnapshot;

    const injectJS = useCallback((code: string, requestId?: string) => {
      const reqJson = JSON.stringify(requestId ?? null);
      const wrappedCode = `
        (function() {
          try {
            window.__agentResult = undefined;
            ${code}
            var __val = (window.__agentResult != null)
              ? String(window.__agentResult).substring(0, 4000)
              : null;
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'result',
              requestId: ${reqJson},
              success: true,
              value: __val
            }));
          } catch(e) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'result',
              requestId: ${reqJson},
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

    const captureAuth = useCallback(() => {
      const code = `
        (function() {
          window.postMessage(JSON.stringify({ type: 'captureAuth' }), '*');
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
      captureAuth,
      reload,
      onMessage,
    }));

    const handleMessage = useCallback((event: WebViewMessageEvent) => {
      try {
        const data: WebViewMessage = JSON.parse(event.nativeEvent.data);
        // Auth snapshots are handled here directly — not routed to the agent
        if (data.type === 'authSnapshot') {
          onAuthSnapshotRef.current?.(data.cookies ?? '', data.localStorage ?? {});
          return;
        }
        messageHandlerRef.current?.(data);
      } catch (e) {
        // ignore non-JSON messages
      }
    }, []);

    // Auth restore runs BEFORE page scripts; BOOTSTRAP must also be present
    const fullPreloadScript = authRestoreScript
      ? authRestoreScript + '\n' + BOOTSTRAP_SCRIPT
      : BOOTSTRAP_SCRIPT;

    return (
      <WebView
        ref={webViewRef}
        source={{ uri: 'https://smartmed.pro/appointment?city=moscow' }}
        style={styles.webview}
        injectedJavaScriptBeforeContentLoaded={fullPreloadScript}
        injectedJavaScript={BOOTSTRAP_SCRIPT}
        onMessage={handleMessage}
        onNavigationStateChange={(navState) => {
          if (navState.url) {
            onNavigationStateChange?.(navState.url);
          }
        }}
        javaScriptEnabled
        domStorageEnabled
        // Share cookies with iOS WKHTTPCookieStorage — survives app restarts
        sharedCookiesEnabled
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
