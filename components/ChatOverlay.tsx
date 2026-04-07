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
// 2/3 of screen
const PANEL_HEIGHT = SCREEN_HEIGHT * 0.68;

// MEDSI brand blue (matches smartmed.pro navbar)
const MEDSI_BLUE = '#0055A5';
const MEDSI_BLUE_LIGHT = '#1A6FBF';

/** Chat-bubble icon drawn with plain Views — no external deps */
function ChatBubbleIcon() {
  return (
    <View style={iconStyles.wrapper}>
      {/* Bubble body */}
      <View style={iconStyles.bubble}>
        {/* Three dots */}
        <View style={iconStyles.dotsRow}>
          <View style={iconStyles.dot} />
          <View style={iconStyles.dot} />
          <View style={iconStyles.dot} />
        </View>
      </View>
      {/* Tail triangle at bottom-left of bubble */}
      <View style={iconStyles.tail} />
    </View>
  );
}

const iconStyles = StyleSheet.create({
  wrapper: {
    width: 26,
    height: 26,
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
  },
  bubble: {
    width: 26,
    height: 20,
    backgroundColor: '#FFFFFF',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 3,
    alignItems: 'center',
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: MEDSI_BLUE,
  },
  tail: {
    marginLeft: 5,
    marginTop: -1,
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 0,
    borderTopWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#FFFFFF',
  },
});

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

  return (
    <>
      {/* ── Floating action button ── */}
      <TouchableOpacity
        style={[styles.fab, isVisible && styles.fabOpen]}
        onPress={togglePanel}
        activeOpacity={0.85}
      >
        {isVisible ? (
          <Text style={styles.fabClose}>✕</Text>
        ) : (
          <ChatBubbleIcon />
        )}
      </TouchableOpacity>

      {/* ── Backdrop ── */}
      {isVisible && (
        <Pressable style={styles.backdrop} onPress={closePanel} />
      )}

      {/* ── Chat panel ── */}
      <Animated.View
        style={[
          styles.panel,
          { transform: [{ translateY: slideAnim }] },
        ]}
        pointerEvents={isVisible ? 'auto' : 'none'}
      >
        {/* Header */}
        <View style={styles.header}>
          {/* Drag handle */}
          <View style={styles.handleBar} />

          <View style={styles.headerRow}>
            {/* Brand */}
            <View style={styles.headerBrand}>
              <View style={styles.headerDot} />
              <Text style={styles.headerTitle}>Ассистент МЕДСИ</Text>
            </View>

            {/* Actions */}
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
                {'Введите команду, например:\n«Запишись к терапевту»'}
              </Text>
            )}
            {messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
            {isLoading && (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color={MEDSI_BLUE} />
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
              style={[
                styles.sendBtn,
                (!inputText.trim() || isLoading) && styles.sendBtnDisabled,
              ]}
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
  // ── FAB ──────────────────────────────────
  fab: {
    position: 'absolute',
    // Sits just above the Webim chat widget (~80 px from bottom)
    bottom: 92,
    right: 16,
    width: 52,
    height: 52,
    borderRadius: 14,        // rounded-square, like modern app icons
    backgroundColor: MEDSI_BLUE,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.28,
    shadowRadius: 8,
    elevation: 10,
    zIndex: 100,
  },
  fabOpen: {
    backgroundColor: MEDSI_BLUE_LIGHT,
    borderRadius: 26,        // circle when showing ✕
  },
  fabClose: {
    fontSize: 18,
    color: '#FFFFFF',
    fontWeight: '600',
  },

  // ── Backdrop ─────────────────────────────
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.30)',
    zIndex: 99,
  },

  // ── Panel ────────────────────────────────
  panel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: PANEL_HEIGHT,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 20,
    zIndex: 100,
  },

  // ── Header ───────────────────────────────
  header: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#EBEBEB',
  },
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#DDDDDD',
    alignSelf: 'center',
    marginBottom: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerBrand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: MEDSI_BLUE,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1A1A1A',
    letterSpacing: 0.1,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  headerBtn: {
    padding: 4,
  },
  headerBtnText: {
    fontSize: 18,
    color: '#666666',
  },

  // ── Body ─────────────────────────────────
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
    marginTop: 48,
    paddingHorizontal: 32,
    lineHeight: 22,
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

  // ── Input bar ────────────────────────────
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#EBEBEB',
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
    backgroundColor: MEDSI_BLUE,
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
