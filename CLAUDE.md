# PALOGPTracker — Claude Code 開発ルール

## ビルド・デプロイ

```bash
# ビルド
export JAVA_HOME="C:/Program Files/Microsoft/jdk-17.0.18.8-hotspot"
cd mobile/android && ./gradlew assembleDebug

# インストール
adb -s 2A151FDH3000Z7 install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

## gh CLI

```bash
GH="/c/Program Files/GitHub CLI/gh.exe"
```

PATH に通っていないため、常にフルパスで使用する。

---

## 開発ワークフロー

### 新機能追加のとき

```
1. feature/xxx ブランチを作成
2. 実装
3. push → PR 作成（gh CLI で自動）
4. Codex に差分レビューを依頼（ユーザーが Codex UI で1クリック）
5. Codex の修正 PR を取り込んで apply
6. main にマージ → ビルド → インストール
```

### ビルドのとき（フルレビュー）

```
1. Codex にフルレビューを依頼（ユーザーが Codex UI で1クリック）
   プロンプト例: "Full codebase review - find all bugs, type issues, memory leaks"
2. Codex が codex/xxx ブランチ + PR を作成
3. Claude が GitHub API でその PR を取得して修正を apply
4. main にマージ → ビルド → インストール
```

### Codex PR の取り込み手順（Claude が実施）

```bash
# Codex が作った PR の番号を取得
GH="/c/Program Files/GitHub CLI/gh.exe"
"$GH" pr list --repo shimeserver/PALOGPTracker --state open

# PR の diff を取得して修正を適用
"$GH" pr diff <PR番号> --repo shimeserver/PALOGPTracker

# 承認・マージ
"$GH" pr merge <PR番号> --repo shimeserver/PALOGPTracker --squash
```

---

## リポジトリ

- GitHub: `shimeserver/PALOGPTracker`
- Codex: codex.openai.com（PALOGPTracker 接続済み）
- デバイス ADB ID: `2A151FDH3000Z7`

## ブランチ戦略

| ブランチ名 | 用途 |
|-----------|------|
| `main` | 本番 |
| `feature/xxx` | 新機能 |
| `fix/xxx` | バグ修正 |
| `codex/xxx` | Codex が自動生成 |
