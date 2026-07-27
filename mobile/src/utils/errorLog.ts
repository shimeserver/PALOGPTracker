import { collection, addDoc, Timestamp } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import { db } from '../firebase/config';

// config.ts の auth export は型解決に既知の問題があるため getAuth() を直接使う
function currentUid(): string | null {
  try { return getAuth().currentUser?.uid ?? null; } catch { return null; }
}

// 未捕捉JSエラーの自動収集（Firestore clientErrors コレクションへ・外部サービス不要）。
// クラッシュ調査を再現待ちなしで始められるようにする。
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
      platform: 'mobile',
      kind,
      message: message.slice(0, 1000),
      stack: (stack ?? '').slice(0, 3000),
      userId: currentUid(),
      createdAt: Timestamp.now(),
    }).catch(() => {});
  } catch { /* 収集自体は決して本体を壊さない */ }
}

export function initErrorReporting(): void {
  // RNのグローバルJSエラーハンドラをラップ（既存ハンドラ=赤画面等は維持する）
  const g = globalThis as { ErrorUtils?: { getGlobalHandler(): (e: Error, isFatal?: boolean) => void; setGlobalHandler(h: (e: Error, isFatal?: boolean) => void): void } };
  const errorUtils = g.ErrorUtils;
  if (!errorUtils) return;
  const prev = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((e, isFatal) => {
    report(isFatal ? 'fatal' : 'error', e?.message ?? String(e), e?.stack);
    prev?.(e, isFatal);
  });
}
