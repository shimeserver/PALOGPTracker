import { useState } from 'react';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../firebase/config';

export default function AuthPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isSignUp) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.logo}>🗺️</div>
        <h1 style={styles.title}>PALOGPTracker</h1>
        <p style={styles.subtitle}>GPS ルート記録・管理</p>

        <form onSubmit={handleSubmit}>
          <input
            style={styles.input}
            type="email"
            placeholder="メールアドレス"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
          <input
            style={styles.input}
            type="password"
            placeholder="パスワード"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
          {error && <p style={styles.error}>{error}</p>}
          <button className="btn-primary" style={{ width: '100%', padding: '13px', marginTop: 8 }} disabled={loading}>
            {loading ? '処理中...' : isSignUp ? '新規登録' : 'ログイン'}
          </button>
        </form>

        <button onClick={() => setIsSignUp(!isSignUp)} style={styles.toggleBtn}>
          {isSignUp ? 'アカウントをお持ちの方はこちら' : '新規登録はこちら'}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#f4f6f9' },
  card: { background: '#fff', borderRadius: 16, padding: 40, width: 380, boxShadow: '0 4px 24px rgba(0,0,0,0.08)', border: '1px solid #e8eaed' },
  logo: { textAlign: 'center', fontSize: 40, marginBottom: 8 },
  title: { color: '#1f2937', textAlign: 'center', marginBottom: 4, fontSize: 26, fontWeight: 700 },
  subtitle: { color: '#6b7280', textAlign: 'center', marginBottom: 32, fontSize: 14 },
  input: {
    width: '100%', background: '#f8f9fa', color: '#1f2937', border: '1.5px solid #e8eaed',
    borderRadius: 8, padding: '12px 16px', marginBottom: 12, fontSize: 15,
    outline: 'none', display: 'block',
  },
  error: { color: '#ef4444', fontSize: 13, marginBottom: 10 },
  toggleBtn: { background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', width: '100%', marginTop: 16, fontSize: 14 },
};
