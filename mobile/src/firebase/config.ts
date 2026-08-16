import { initializeApp, getApps, getApp } from 'firebase/app';
import { initializeAuth, getAuth, getReactNativePersistence } from 'firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey:            process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain:        process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

// ビルド時にEXPO_PUBLIC_*が注入されていないと initializeAuth が
// 「auth/invalid-api-key」で同期throwし、エラーレポータ(errorLog)自体も
// このモジュールに依存しているため無言の起動クラッシュになる。
// 原因を即特定できるよう、欠けているキーを明示してから落とす。
const missingKeys = Object.entries(firebaseConfig).filter(([, v]) => !v).map(([k]) => k);
if (missingKeys.length > 0) {
  throw new Error(
    `Firebase設定がビルドに含まれていません: ${missingKeys.join(', ')} — ` +
    'CIならジョブレベルenvのEXPO_PUBLIC_*、ローカルならmobile/.envを確認してください'
  );
}

let app;
let auth;

if (getApps().length === 0) {
  app = initializeApp(firebaseConfig);
  auth = initializeAuth(app, {
    persistence: getReactNativePersistence(AsyncStorage),
  });
} else {
  app = getApp();
  auth = getAuth(app);
}

export { auth };
export const db = getFirestore(app);
export const storage = getStorage(app);
export default app;
