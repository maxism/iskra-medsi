import { StyleSheet, Text, View } from 'react-native';

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

export default function ChatMessage({ message }: Props) {
  const isUser = message.role === 'user';
  const isError = message.role === 'error';

  return (
    <View style={[styles.row, isUser ? styles.rowRight : styles.rowLeft]}>
      <View
        style={[
          styles.bubble,
          isUser && styles.bubbleUser,
          isError && styles.bubbleError,
          !isUser && !isError && styles.bubbleAgent,
        ]}
      >
        <Text
          style={[
            styles.text,
            isUser && styles.textUser,
            isError && styles.textError,
          ]}
        >
          {message.text}
        </Text>
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
});
