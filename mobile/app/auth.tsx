import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { useAuthStore } from '../src/store/authStore';

export default function AuthScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const { signIn, signUp } = useAuthStore();

  const handleSubmit = async () => {
    if (!email || !password) {
      Alert.alert('エラー', 'メールとパスワードを入力してください');
      return;
    }
    setLoading(true);
    try {
      if (isSignUp) {
        await signUp(email, password);
      } else {
        await signIn(email, password);
      }
    } catch (e: any) {
      Alert.alert('エラー', e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.inner}>
        <Text style={styles.title}>PALOGPTracker</Text>
        <Text style={styles.subtitle}>GPS ルート記録アプリ</Text>

        <TextInput
          style={styles.input}
          placeholder="メールアドレス"
          placeholderTextColor="#888"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
        />
        <TextInput
          style={styles.input}
          placeholder="パスワード"
          placeholderTextColor="#888"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={loading}
        >
          <Text style={styles.buttonText}>
            {loading ? '処理中...' : isSignUp ? '新規登録' : 'ログイン'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => setIsSignUp(!isSignUp)}>
          <Text style={styles.toggle}>
            {isSignUp ? 'アカウントをお持ちの方はこちら' : '新規登録はこちら'}
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  inner: { flex: 1, justifyContent: 'center', padding: 32 },
  title: { fontSize: 28, fontWeight: 'bold', color: '#4fc3f7', textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#888', textAlign: 'center', marginBottom: 48 },
  input: {
    backgroundColor: '#16213e',
    color: '#fff',
    borderRadius: 10,
    padding: 16,
    marginBottom: 16,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#0f3460',
  },
  button: {
    backgroundColor: '#4fc3f7',
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 16,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#1a1a2e', fontWeight: 'bold', fontSize: 16 },
  toggle: { color: '#4fc3f7', textAlign: 'center', fontSize: 14 },
});
