import { useRef, useState, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebViewAgent, { WebViewAgentRef } from '../components/WebViewAgent';
import ChatOverlay from '../components/ChatOverlay';
import { useWebViewAgent } from '../hooks/useWebViewAgent';

export default function IndexScreen() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebViewAgentRef>(null);
  const [currentUrl, setCurrentUrl] = useState('https://medsi.ru');

  const { messages, isLoading, sendMessage, clearMessages } = useWebViewAgent(
    webViewRef,
    currentUrl,
  );

  const handleRefresh = useCallback(() => {
    webViewRef.current?.reload();
  }, []);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <WebViewAgent
        ref={webViewRef}
        onNavigationStateChange={(url) => setCurrentUrl(url)}
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
