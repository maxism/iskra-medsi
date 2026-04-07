import {
  useRef,
  useState,
  useEffect,
  useCallback,
} from 'react';
import {
  Animated,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ActivityIndicator,
} from 'react-native';
import ChatMessage, { Message } from './ChatMessage';

interface Props {
  messages: Message[];
  isLoading: boolean;
  currentUrl: string;
  onSendMessage: (text: string) => void;
  onRefresh: () => void;
  onClearMessages: () => void;
}

const SCREEN_HEIGHT = Dimensions.get('window').height;
const PANEL_HEIGHT = SCREEN_HEIGHT * 0.55;

export default function ChatOverlay({
  messages,
  isLoading,
  currentUrl,
  onSendMessage,
  onRefresh,
  onClearMessages,
}: Props) {
  const [isVisible, setIsVisible] = useState(false);
  const [inputText, setInputText] = useState('');
  const slideAnim = useRef(new Animated.Value(PANEL_HEIGHT)).current;
  const scrollRef = useRef<ScrollView>(null);

  const openPanel = useCallback(() => {
    setIsVisible(true);
    Animated.spring(slideAnim, {
      toValue: 0,
      useNativeDriver: true,
      bounciness: 4,
    }).start();
  }, [slideAnim]);

  const closePanel = useCallback(() => {
    Animated.timing(slideAnim, {
      toValue: PANEL_HEIGHT,
      duration: 250,
      useNativeDriver: true,
    }).start(() => setIsVisible(false));
  }, [slideAnim]);

  const togglePanel = useCallback(() => {
    if (isVisible) {
      closePanel();
    } else {
      openPanel();
    }
  }, [isVisible, openPanel, closePanel]);

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || isLoading) return;
    setInputText('');
    onSendMessage(text);
  }, [inputText, isLoading, onSendMessage]);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        scrollRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages]);

  const displayUrl = currentUrl.length > 45
    ? currentUrl.substring(0, 45) + '…'
    : currentUrl;

  return (
    <>
      {/* Floating action button */}
      <TouchableOpacity
        style={styles.fab}
        onPress={togglePanel}
        activeOpacity={0.85}
      >
        <Text style={styles.fabIcon}>{isVisible ? '✕' : '💬'}</Text>
      </TouchableOpacity>

      {/* Backdrop */}
      {isVisible && (
        <Pressable style={styles.backdrop} onPress={closePanel} />
      )}

      {/* Chat panel */}
      <Animated.View
        style={[
          styles.panel,
          { transform: [{ translateY: slideAnim }] },
        ]}
        pointerEvents={isVisible ? 'auto' : 'none'}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View style={styles.handleBar} />
            <Text style={styles.urlText} numberOfLines={1}>
              {displayUrl}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.headerBtn}
              onPress={onRefresh}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.headerBtnText}>↺</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.headerBtn}
              onPress={onClearMessages}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.headerBtnText}>🗑</Text>
            </TouchableOpacity>
          </View>
        </View>

        <KeyboardAvoidingView
          style={styles.body}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          {/* Messages */}
          <ScrollView
            ref={scrollRef}
            style={styles.messageList}
            contentContainerStyle={styles.messageListContent}
            keyboardShouldPersistTaps="handled"
          >
            {messages.length === 0 && (
              <Text style={styles.emptyHint}>
                Введите команду, например: «Запишись к терапевту»
              </Text>
            )}
            {messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
            {isLoading && (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color="#0066CC" />
                <Text style={styles.loadingText}>Обработка…</Text>
              </View>
            )}
          </ScrollView>

          {/* Input bar */}
          <View style={styles.inputBar}>
            <TextInput
              style={styles.input}
              value={inputText}
              onChangeText={setInputText}
              placeholder="Введите команду…"
              placeholderTextColor="#AAAAAA"
              multiline
              maxLength={500}
              returnKeyType="send"
              onSubmitEditing={handleSend}
              editable={!isLoading}
            />
            <TouchableOpacity
              style={[styles.sendBtn, (!inputText.trim() || isLoading) && styles.sendBtnDisabled]}
              onPress={handleSend}
              disabled={!inputText.trim() || isLoading}
              activeOpacity={0.8}
            >
              <Text style={styles.sendBtnText}>➤</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    top: 60,
    right: 20,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#0066CC',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 8,
    zIndex: 100,
  },
  fabIcon: {
    fontSize: 22,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.25)',
    zIndex: 99,
  },
  panel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: PANEL_HEIGHT,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 20,
    zIndex: 100,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5E5',
  },
  headerLeft: {
    flex: 1,
    gap: 6,
  },
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#DDDDDD',
    alignSelf: 'center',
    marginBottom: 4,
  },
  urlText: {
    fontSize: 11,
    color: '#888888',
    textAlign: 'center',
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
    marginLeft: 12,
  },
  headerBtn: {
    padding: 4,
  },
  headerBtnText: {
    fontSize: 18,
    color: '#555555',
  },
  body: {
    flex: 1,
  },
  messageList: {
    flex: 1,
  },
  messageListContent: {
    paddingVertical: 12,
    flexGrow: 1,
  },
  emptyHint: {
    textAlign: 'center',
    color: '#BBBBBB',
    fontSize: 14,
    marginTop: 40,
    paddingHorizontal: 24,
    lineHeight: 20,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  loadingText: {
    fontSize: 13,
    color: '#888888',
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5E5',
    gap: 8,
    backgroundColor: '#FFFFFF',
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    borderWidth: 1,
    borderColor: '#DDDDDD',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: '#1A1A1A',
    backgroundColor: '#F8F8F8',
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#0066CC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    backgroundColor: '#CCCCCC',
  },
  sendBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
  },
});
