# PALOGPTracker セルフホスト セットアップガイド

自分のFirebaseプロジェクトとGoogle Maps APIキーを使って、PALOGPTrackerを動かす手順です。

---

## 必要なもの

- Node.js 18以上
- Google アカウント
- （モバイルアプリを使う場合）Expo CLI / Android Studio / Xcode

---

## Step 1: Firebaseプロジェクトの作成

1. [Firebase Console](https://console.firebase.google.com/) を開く
2. **「プロジェクトを追加」** をクリック
3. プロジェクト名を入力（例: `my-gpstracker`）して作成

### 1-1. Authentication の有効化

1. 左メニュー **「Authentication」** → **「始める」**
2. **「Sign-in method」** タブ → **「Google」** を有効化
3. サポートメールを設定して保存

### 1-2. Firestore Database の作成

1. 左メニュー **「Firestore Database」** → **「データベースの作成」**
2. リージョンは **`asia-northeast1`（東京）** を推奨
3. **本番環境モード** で開始

#### セキュリティルールの設定

Firestore のルールタブで以下を貼り付けて公開:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /routes/{routeId} {
      allow read, write: if request.auth != null && request.auth.uid == resource.data.userId;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.userId;
    }
    match /landmarks/{landmarkId} {
      allow read, write: if request.auth != null && request.auth.uid == resource.data.userId;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.userId;
      match /visits/{visitId} {
        allow read, write: if request.auth != null;
      }
    }
    match /tags/{tagId} {
      allow read, write: if request.auth != null && request.auth.uid == resource.data.userId;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.userId;
    }
  }
}
```

### 1-3. Storage の有効化

1. 左メニュー **「Storage」** → **「始める」**
2. 本番環境モードで開始、リージョンは Firestore と同じ場所

#### Storage ルール

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /landmarks/{userId}/{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

### 1-4. WebアプリのAPIキーを取得

1. プロジェクト設定（歯車アイコン）→ **「マイアプリ」**
2. **「ウェブ」** アイコンをクリックしてアプリを登録
3. 表示される `firebaseConfig` の値をメモする:
   ```
   apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId
   ```

---

## Step 2: Google Maps API キーの取得

1. [Google Cloud Console](https://console.cloud.google.com/) を開く
2. 左上のプロジェクトセレクタで Firebase と同じプロジェクトを選択（または新規作成）
3. **「APIとサービス」** → **「APIとサービスを有効化」**
4. 以下のAPIを有効化:
   - **Maps JavaScript API**
   - **Places API**
5. **「認証情報」** → **「認証情報を作成」** → **「APIキー」**
6. 作成されたAPIキーをメモする
7. （推奨）キーの制限で「HTTPリファラー」にあなたのドメインを指定

---

## Step 3: Webアプリのセットアップ

```bash
cd web
cp .env.example .env
```

`.env` を開いて各値を入力:

```env
VITE_GOOGLE_MAPS_API_KEY=取得したGoogleMapsのAPIキー

VITE_FIREBASE_API_KEY=FirebaseのapiKey
VITE_FIREBASE_AUTH_DOMAIN=FirebaseのauthDomain
VITE_FIREBASE_PROJECT_ID=FirebaseのprojectId
VITE_FIREBASE_STORAGE_BUCKET=FirebaseのstorageBucket
VITE_FIREBASE_MESSAGING_SENDER_ID=FirebaseのmessagingSenderId
VITE_FIREBASE_APP_ID=FirebaseのappId
```

### ローカル開発

```bash
cd web
npm install
npm run dev
```

ブラウザで `http://localhost:5173` を開く。

### 本番ビルド

```bash
cd web
npm run build
```

`web/dist` フォルダの中身をWebサーバーにアップロードする。

#### Firebase Hosting で公開する場合

```bash
npm install -g firebase-tools
firebase login
firebase init hosting   # distフォルダを指定
firebase deploy
```

---

## Step 4: モバイルアプリのセットアップ（任意）

```bash
cd mobile
cp .env.example .env
```

`.env` を開いて各値を入力（Webと同じ値でOK）:

```env
EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=取得したGoogleMapsのAPIキー

EXPO_PUBLIC_FIREBASE_API_KEY=FirebaseのapiKey
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=FirebaseのauthDomain
EXPO_PUBLIC_FIREBASE_PROJECT_ID=FirebaseのprojectId
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=FirebaseのstorageBucket
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=FirebaseのmessagingSenderId
EXPO_PUBLIC_FIREBASE_APP_ID=FirebaseのappId
```

### 開発環境での起動

```bash
cd mobile
npm install
npx expo start
```

### APKビルド（Android）

```bash
npx expo build:android
# または EAS Build を使う場合:
npx eas build --platform android
```

---

## 注意事項

- `.env` ファイルは **絶対にGitにコミットしない**（`.gitignore` に設定済み）
- APIキーは第三者と共有しない
- Firebase の無料枠（Sparkプラン）で十分使えるが、大量データの場合は注意
- Google Maps APIは月$200の無料枠あり（個人利用なら通常無料枠内）
