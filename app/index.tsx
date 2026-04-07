import { useRef, useState, useCallback, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebViewAgent, { WebViewAgentRef } from '../components/WebViewAgent';
import ChatOverlay from '../components/ChatOverlay';
import { useWebViewAgent } from '../hooks/useWebViewAgent';
import {
  loadAuthSnapshot,
  saveAuthSnapshot,
  buildAuthRestoreScript,
} from '../services/authPersistence';

// Delay before capturing auth after a URL change (let the SPA settle)
const AUTH_CAPTURE_DELAY_MS = 3000;

export default function IndexScreen() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebViewAgentRef>(null);
  const [currentUrl, setCurrentUrl] = useState('https://medsi.ru');
  const [authRestoreScript, setAuthRestoreScript] = useState<string | undefined>(undefined);
  const [authReady, setAuthReady] = useState(false);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load saved auth on mount — WebView renders after this resolves
  useEffect(() => {
    loadAuthSnapshot().then((snap) => {
      if (snap) {
        setAuthRestoreScript(buildAuthRestoreScript(snap));
      }
      setAuthReady(true);
    });
  }, []);

  const { messages, isLoading, sendMessage, clearMessages } = useWebViewAgent(
    webViewRef,
    currentUrl,
  );

  const handleRefresh = useCallback(() => {
    webViewRef.current?.reload();
  }, []);

  // Capture auth after each navigation — delayed so the SPA finishes loading
  const handleNavigationStateChange = useCallback((url: string) => {
    setCurrentUrl(url);
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    captureTimerRef.current = setTimeout(() => {
      webViewRef.current?.captureAuth();
    }, AUTH_CAPTURE_DELAY_MS);
  }, []);

  // Receive auth snapshot from WebView → persist to AsyncStorage
  const handleAuthSnapshot = useCallback(
    (cookies: string, ls: Record<string, string>) => {
      // Only save if there's meaningful data (user is likely logged in)
      if (Object.keys(ls).length > 0 || cookies.length > 0) {
        saveAuthSnapshot({ cookies, localStorage: ls, savedAt: Date.now() });
      }
    },
    [],
  );

  if (!authReady) {
    // Wait for AsyncStorage read before rendering WebView
    // Typically resolves in <50ms — no visible flash
    return <View style={styles.container} />;
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <WebViewAgent
        ref={webViewRef}
        onNavigationStateChange={handleNavigationStateChange}
        authRestoreScript={authRestoreScript}
        onAuthSnapshot={handleAuthSnapshot}
      />
      <ChatOverlay
        messages={messages}
        isLoading={isLoading}
        currentUrl={currentUrl}
        onSendMessage={sendMessage}
        onRefresh={handleRefresh}
        onClearMessages={clearMessages}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
});
