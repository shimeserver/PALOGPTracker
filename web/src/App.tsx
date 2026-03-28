import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { useJsApiLoader, type Libraries } from '@react-google-maps/api';
import { auth } from './firebase/config';
import AuthPage from './pages/AuthPage';
import MainPage from './pages/MainPage';
import './App.css';

// librariesを外部で定義することで安定した参照を保つ（useJsApiLoaderの要件）
const LIBRARIES: Libraries = ['places'];

// Google Maps スクリプトをアプリ最上位で1回だけロード
// これにより地図コンポーネントの再マウント時に再課金されない
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const { isLoaded: mapsLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY,
    libraries: LIBRARIES,
    language: 'ja',
  });

  useEffect(() => {
    return onAuthStateChanged(auth, u => {
      setUser(u);
      setAuthLoading(false);
    });
  }, []);

  if (authLoading || !mapsLoaded) {
    return (
      <div className="loading-screen">
        <div className="loading-text">読み込み中...</div>
      </div>
    );
  }

  return user ? <MainPage user={user} /> : <AuthPage />;
}
