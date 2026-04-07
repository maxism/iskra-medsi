import { ScrollView, StyleSheet, Text, View } from 'react-native';

export type MessageRole = 'user' | 'agent' | 'error';

export interface Message {
  id: string;
  role: MessageRole;
  text: string;
  timestamp: number;
}

interface Props {
  message: Message;
}

/** Strip markdown symbols the LLM may accidentally produce */
function sanitizeText(raw: string): string {
  return raw
    .replace(/^#{1,6}\s+/gm, '')       // ## headers
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold**
    .replace(/\*(.+?)\*/g, '$1')       // *italic*
    .replace(/`(.+?)`/g, '$1')         // `code`
    .replace(/^[-*]\s+/gm, '• ')       // - list → bullet
    .replace(/\|[-| :]+\|/g, '')       // table dividers
    .replace(/\|/g, ' ')               // table pipes
    .replace(/---+/g, '─────')         // horizontal rules
    .trim();
}

const LONG_MESSAGE_THRESHOLD = 300;

export default function ChatMessage({ message }: Props) {
  const isUser = message.role === 'user';
  const isError = message.role === 'error';
  const displayText = isUser ? message.text : sanitizeText(message.text);
  const isLong = displayText.length > LONG_MESSAGE_THRESHOLD;

  const textContent = (
    <Text
      style={[
        styles.text,
        isUser && styles.textUser,
        isError && styles.textError,
      ]}
    >
      {displayText}
    </Text>
  );

  return (
    <View style={[styles.row, isUser ? styles.rowRight : styles.rowLeft]}>
      <View
        style={[
          styles.bubble,
          isUser && styles.bubbleUser,
          isError && styles.bubbleError,
          !isUser && !isError && styles.bubbleAgent,
          isLong && styles.bubbleLong,
        ]}
      >
        {isLong ? (
          <ScrollView style={styles.scrollArea} nestedScrollEnabled>
            {textContent}
          </ScrollView>
        ) : (
          textContent
        )}
        <Text style={[styles.time, isUser && styles.timeUser]}>
          {new Date(message.timestamp).toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    marginVertical: 4,
    paddingHorizontal: 12,
  },
  rowLeft: {
    justifyContent: 'flex-start',
  },
  rowRight: {
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  bubbleUser: {
    backgroundColor: '#0066CC',
    borderBottomRightRadius: 4,
  },
  bubbleAgent: {
    backgroundColor: '#F0F0F0',
    borderBottomLeftRadius: 4,
  },
  bubbleError: {
    backgroundColor: '#FFE5E5',
    borderBottomLeftRadius: 4,
  },
  text: {
    fontSize: 15,
    lineHeight: 20,
    color: '#1A1A1A',
  },
  textUser: {
    color: '#FFFFFF',
  },
  textError: {
    color: '#CC0000',
  },
  time: {
    fontSize: 11,
    color: '#888888',
    marginTop: 4,
    alignSelf: 'flex-end',
  },
  timeUser: {
    color: 'rgba(255,255,255,0.7)',
  },
  bubbleLong: {
    maxWidth: '92%',
  },
  scrollArea: {
    maxHeight: 320,
  },
});
