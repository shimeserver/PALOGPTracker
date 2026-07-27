import { collection, addDoc, Timestamp } from 'firebase/firestore';
import { db, auth } from '../firebase/config';

// 未捕捉エラーの自動収集（Firestore clientErrors コレクションへ・外部サービス不要）。
// 「なんか失敗するんだけど」の調査を、再現待ちなしでコンソールから始められるようにする。
// 送信は控えめ: 同一メッセージは1回、セッション上限10件、失敗しても本体に影響しない。

const seen = new Set<string>();
let sentCount = 0;
const MAX_PER_SESSION = 10;

function report(kind: string, message: string, stack?: string) {
  try {
    const key = message.slice(0, 200);
    if (seen.has(key) || sentCount >= MAX_PER_SESSION) return;
    seen.add(key);
    sentCount++;
    addDoc(collection(db, 'clientErrors'), {
      platform: 'web',
      kind,
      message: message.slice(0, 1000),
      stack: (stack ?? '').slice(0, 3000),
      userId: auth.currentUser?.uid ?? null,
      userAgent: navigator.userAgent.slice(0, 200),
      url: location.href.slice(0, 300),
      createdAt: Timestamp.now(),
    }).catch(() => {});
  } catch { /* 収集自体は決して本体を壊さない */ }
}

export function initErrorReporting(): void {
  window.addEventListener('error', e => {
    report('error', e.message || String(e.error), e.error?.stack);
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    report('unhandledrejection', r?.message ?? String(r), r?.stack);
  });
}
