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
  level?: 'log' | 'warn' | 'error' | 'info';
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
  autoId?: string; // data-automation-id or data-testid — stable identifier
}

export interface WebViewAgentRef {
  injectJS: (code: string, requestId?: string) => void;
  captureDOM: (requestId: string) => void;
  captureAuth: () => void;
  reload: () => void;
  onMessage: (handler: (msg: WebViewMessage) => void) => void;
  /** Resolves when the WebView finishes loading (onLoadEnd). Resolves immediately if not loading. */
  waitForPageLoad: (timeoutMs?: number) => Promise<void>;
}

interface Props {
  onNavigationStateChange?: (url: string) => void;
  /** Pre-built script to restore localStorage + cookies — runs before page scripts */
  authRestoreScript?: string;
  /** Called whenever a captureAuth() snapshot arrives */
  onAuthSnapshot?: (cookies: string, ls: Record<string, string>) => void;
}

// Desktop macOS Safari UA — no "Mobile" token, so the site's mobile/PWA guard
// never redirects to /pwa.
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3_1) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Safari/605.1.15';

/**
 * Runs before page scripts (injectedJavaScriptBeforeContentLoaded).
 * 1. Hides window.ReactNativeWebView from page scripts (replaced by window.__rnwv).
 * 2. Overrides navigator properties to match the desktop UA sent in HTTP headers.
 */
const PRELOAD_SCRIPT = `
(function() {
  // Hide the RN bridge from page scripts — use window.__rnwv internally instead.
  if (window.ReactNativeWebView) {
    window.__rnwv = window.ReactNativeWebView;
    try {
      Object.defineProperty(window, 'ReactNativeWebView', {
        get: function() { return undefined; },
        set: function() {},
        enumerable: false,
        configurable: true,
      });
    } catch(e) {}
  }

  // Match navigator JS properties to the desktop UA we send in HTTP headers.
  var _ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Safari/605.1.15';
  try { Object.defineProperty(navigator, 'userAgent',      { get: function(){ return _ua; }, configurable: true }); } catch(e) {}
  try { Object.defineProperty(navigator, 'appVersion',     { get: function(){ return _ua.replace('Mozilla/',''); }, configurable: true }); } catch(e) {}
  try { Object.defineProperty(navigator, 'platform',       { get: function(){ return 'MacIntel'; }, configurable: true }); } catch(e) {}
  try { Object.defineProperty(navigator, 'vendor',         { get: function(){ return 'Apple Computer, Inc.'; }, configurable: true }); } catch(e) {}
  try { Object.defineProperty(navigator, 'maxTouchPoints', { get: function(){ return 0; }, configurable: true }); } catch(e) {}
  try { if (!window.outerWidth)  Object.defineProperty(window, 'outerWidth',  { get: function(){ return window.innerWidth; },  configurable: true }); } catch(e) {}
  try { if (!window.outerHeight) Object.defineProperty(window, 'outerHeight', { get: function(){ return window.innerHeight; }, configurable: true }); } catch(e) {}
})();
`;

/** Forwards console.log/warn/error/info from the WebView page to Metro. */
const CONSOLE_FORWARD_SCRIPT = `
(function() {
  var _rnwv = function() { return window.__rnwv || window.ReactNativeWebView; };
  var _send = function(level, msg) {
    try {
      var rn = _rnwv();
      if (rn) rn.postMessage(JSON.stringify({ type: 'log', level: level, message: msg }));
    } catch(e) {}
  };
  var _wrap = function(level, orig) {
    return function() {
      try { orig.apply(console, arguments); } catch(e) {}
      try {
        var args = Array.from(arguments).map(function(a) {
          try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch(e) { return String(a); }
        });
        _send(level, args.join(' '));
      } catch(e) {}
    };
  };
  console.log   = _wrap('log',   console.log);
  console.warn  = _wrap('warn',  console.warn);
  console.error = _wrap('error', console.error);
  console.info  = _wrap('info',  console.info);
})();
`;

const BOOTSTRAP_SCRIPT = `
(function() {
  if (window.__agentBootstrapped) return;
  window.__agentBootstrapped = true;

  function getSelector(el) {
    if (el.id) return '#' + el.id;
    if (el.getAttribute('name')) return el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]';
    if (el.getAttribute('data-testid')) return '[data-testid="' + el.getAttribute('data-testid') + '"]';
    var classes = (el.className || '').split(' ').map(function(c){ return c.trim(); }).filter(Boolean);
    for (var i = 0; i < classes.length; i++) {
      var sel = el.tagName.toLowerCase() + '.' + classes[i];
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch(e) {}
    }
    return null;
  }

  window.__agentCaptureDOM = function(requestId) {
    try {
      var selectors = 'button, input, a, select, textarea, [role="button"], [onclick], [data-automation-id]';
      var elements = Array.from(document.querySelectorAll(selectors));
      var seen = {};
      var snapshot = [];
      for (var i = 0; i < elements.length && snapshot.length < 80; i++) {
        var el = elements[i];
        var autoId = el.getAttribute('data-automation-id') || '';
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        var text = (el.textContent || el.innerText || '').trim().replace(/\\s+/g, ' ').substring(0, 80);
        var placeholder = el.placeholder || '';
        var isClickable = el.tagName === 'BUTTON' || el.tagName === 'A';
        if (!isClickable && !text && !placeholder && !el.id && !el.getAttribute('name') && !autoId) continue;
        var key = el.tagName + '|' + text + '|' + placeholder + '|' + autoId;
        if (seen[key]) continue;
        seen[key] = true;
        var item = { tag: el.tagName.toLowerCase() };
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
      (window.__rnwv||window.ReactNativeWebView).postMessage(JSON.stringify({
        type: 'domSnapshot',
        requestId: requestId,
        snapshot: snapshot
      }));
    } catch(e) {
      try {
        (window.__rnwv||window.ReactNativeWebView).postMessage(JSON.stringify({
          type: 'domSnapshot',
          requestId: requestId,
          snapshot: []
        }));
      } catch(e2) {}
    }
  };

  // Auth capture — triggered by captureAuth() injecting a window.postMessage
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
        (window.__rnwv||window.ReactNativeWebView).postMessage(JSON.stringify({
          type: 'authSnapshot',
          cookies: cookies,
          localStorage: ls
        }));
      }
    } catch(e) {}
  });
})();
true;
`;

/**
 * Runs after every page load. Locks the viewport so iOS WKWebView never
 * auto-zooms on input focus.
 */
const ZOOM_LOCK_SCRIPT = `
(function() {
  var content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
  var existing = document.querySelector('meta[name="viewport"]');
  if (existing) {
    existing.setAttribute('content', content);
  } else if (document.head) {
    var m = document.createElement('meta');
    m.name = 'viewport';
    m.setAttribute('content', content);
    document.head.appendChild(m);
  }
})();
`;

const WebViewAgent = forwardRef<WebViewAgentRef, Props>(
  ({ onNavigationStateChange, authRestoreScript, onAuthSnapshot }, ref) => {
    const webViewRef = useRef<WebView>(null);
    const messageHandlerRef = useRef<((msg: WebViewMessage) => void) | null>(null);
    const onAuthSnapshotRef = useRef(onAuthSnapshot);
    onAuthSnapshotRef.current = onAuthSnapshot;
    const isPageLoadingRef = useRef(false);
    const pageLoadResolversRef = useRef<Array<() => void>>([]);

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
            (window.__rnwv||window.ReactNativeWebView).postMessage(JSON.stringify({
              type: 'result',
              requestId: ${reqJson},
              success: true,
              value: __val
            }));
          } catch(e) {
            try {
              (window.__rnwv||window.ReactNativeWebView).postMessage(JSON.stringify({
                type: 'result',
                requestId: ${reqJson},
                success: false,
                error: String(e && e.message ? e.message : e)
              }));
            } catch(e2) {}
          }
        })();
        true;
      `;
      webViewRef.current?.injectJavaScript(wrappedCode);
    }, []);

    const captureDOM = useCallback((requestId: string) => {
      const reqJson = JSON.stringify(requestId);
      const code = `
        (function() {
          if (typeof window.__agentCaptureDOM === 'function') {
            window.__agentCaptureDOM(${reqJson});
          } else {
            try {
              (window.__rnwv||window.ReactNativeWebView).postMessage(JSON.stringify({
                type: 'domSnapshot',
                requestId: ${reqJson},
                snapshot: []
              }));
            } catch(e) {}
          }
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

    const waitForPageLoad = useCallback((timeoutMs = 6000): Promise<void> => {
      if (!isPageLoadingRef.current) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          pageLoadResolversRef.current = pageLoadResolversRef.current.filter(fn => fn !== onLoaded);
          resolve();
        }, timeoutMs);
        const onLoaded = () => {
          clearTimeout(timer);
          resolve();
        };
        pageLoadResolversRef.current.push(onLoaded);
      });
    }, []);

    useImperativeHandle(ref, () => ({
      injectJS,
      captureDOM,
      captureAuth,
      reload,
      onMessage,
      waitForPageLoad,
    }));

    const handleMessage = useCallback((event: WebViewMessageEvent) => {
      try {
        const data: WebViewMessage = JSON.parse(event.nativeEvent.data);
        if (data.type === 'authSnapshot') {
          onAuthSnapshotRef.current?.(data.cookies ?? '', data.localStorage ?? {});
          return;
        }
        if (data.type === 'log') {
          const prefix = `[Page:${data.level ?? 'log'}]`;
          if (data.level === 'error') console.error(prefix, data.message);
          else if (data.level === 'warn') console.warn(prefix, data.message);
          else console.log(prefix, data.message);
          return;
        }
        messageHandlerRef.current?.(data);
      } catch (e) {
        // ignore non-JSON messages
      }
    }, []);

    // Auth restore runs BEFORE page scripts so tokens are available immediately.
    const fullPreloadScript = authRestoreScript
      ? authRestoreScript + '\n' + PRELOAD_SCRIPT + '\n' + CONSOLE_FORWARD_SCRIPT + '\n' + BOOTSTRAP_SCRIPT
      : PRELOAD_SCRIPT + '\n' + CONSOLE_FORWARD_SCRIPT + '\n' + BOOTSTRAP_SCRIPT;

    return (
      <WebView
        ref={webViewRef}
        source={{ uri: 'https://online.mtsdengi.ru/' }}
        style={styles.webview}
        userAgent={DESKTOP_UA}
        injectedJavaScriptBeforeContentLoaded={fullPreloadScript}
        injectedJavaScript={ZOOM_LOCK_SCRIPT + BOOTSTRAP_SCRIPT + '\ntrue;'}
        onMessage={handleMessage}
        onLoadStart={() => { isPageLoadingRef.current = true; }}
        onLoadEnd={() => {
          isPageLoadingRef.current = false;
          const resolvers = pageLoadResolversRef.current.splice(0);
          resolvers.forEach(fn => fn());
        }}
        onNavigationStateChange={(navState) => {
          if (navState.url) onNavigationStateChange?.(navState.url);
        }}
        javaScriptEnabled
        domStorageEnabled
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
