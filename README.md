# WordPressの記事をNoteへ自動移行するツール

このツールを使うと、WordPressの記事をまとめて取得し、Noteへ自動投稿できます。

## できること

- WordPressの記事を一括取得
- Noteへ自動投稿
  - 下書き保存
  - 一括公開

---

## 作業の流れ

```
STEP 1: WordPressの記事を取得
    ↓
STEP 2: Noteへ投稿
    ↓
STEP 3: 下書きを公開（必要な場合のみ）
```

---

## 動作環境

| OS | バージョン |
|----|-----------|
| Mac | macOS 12以上推奨 |
| Windows | Windows 10 / 11 |

---

## STEP 0: Node.jsをインストール

このツールを動かすためにNode.jsが必要です。

**インストール確認**

ターミナルを開いて実行します。

```bash
node -v
```

以下のように表示されればOKです。

```
v22.0.0
```

表示されない場合はNode.jsをインストールしてください。

**ダウンロード**

[Node.js公式サイト](https://nodejs.org/) からインストーラーをダウンロードして、そのまま「次へ」を押して進めればOKです。

---

## STEP 1: ツールをダウンロード

GitHubからダウンロードします。

```bash
git clone https://github.com/atueda/NoteWordpress.git
```

または、GitHub画面の `Code` → `Download ZIP` からダウンロードしてください。

---

## STEP 2: フォルダを開く

ターミナルでフォルダへ移動します。

```bash
cd ~/Downloads/wp-to-note
```

---

## STEP 3: 必要なソフトをインストール

以下を1回だけ実行します。

```bash
npm install
```

次にブラウザ制御ソフトをインストールします。

```bash
npx playwright install chromium
```

完了したら準備完了です。

---

## STEP 4: 設定ファイルを作成

フォルダ内に `.env` という名前のファイルを作成します。中身は以下のように入力してください。

```ini
# WordPress 設定
WP_URL=https://あなたのサイトURL
WP_PER_PAGE=20
WP_MAX_PAGES=11
WP_OUTPUT_DIR=./note-export

# Note 設定
NOTE_EMAIL=あなたのメールアドレス
NOTE_PASSWORD=あなたのパスワード
NOTE_TAGS=タグ1,タグ2,タグ3
NOTE_PUBLISH_MODE=draft
```

**設定内容の説明**

| 設定項目 | 内容 | 例 |
|---------|------|-----|
| `WP_URL` | WordPressのURL（末尾スラッシュなし） | `https://example.com` |
| `WP_PER_PAGE` | 1回のAPIで取得する件数（最大100） | `20` |
| `WP_MAX_PAGES` | 取得するページ数（件数 × ページ数 = 最大取得数） | `11` |
| `WP_OUTPUT_DIR` | 記事ファイルの出力先フォルダ | `./note-export` |
| `NOTE_EMAIL` | Noteのメールアドレス | `you@example.com` |
| `NOTE_PASSWORD` | Noteのパスワード | |
| `NOTE_TAGS` | 投稿時のタグ（カンマ区切り） | `ADHD,大人の発達障害` |
| `NOTE_PUBLISH_MODE` | `draft`=下書き保存 / `publish`=即公開 | `draft` |

---

## STEP 5: WordPressの記事を取得

以下を実行します。

```bash
node wp-to-note.js
```

成功すると `note-export` フォルダが作成されます。

---

## STEP 6: Noteへ投稿

以下を実行します。

```bash
node note-auto-post.js
```

ブラウザが起動します。初回のみNoteへログインしてください。ログイン後は自動で保存されるため、次回以降はログイン不要です。

**投稿モード**

| モード | 設定 | 動作 |
|--------|------|------|
| 下書き保存 | `NOTE_PUBLISH_MODE=draft` | 記事は公開されません。Noteの下書きに保存されます。 |
| 自動公開 | `NOTE_PUBLISH_MODE=publish` | 投稿後すぐ公開されます。 |

---

## STEP 7: 下書きをまとめて公開

`NOTE_PUBLISH_MODE=draft` を利用した場合のみ実行します。

```bash
node note-publish-one.js
```

この処理を行うと「下書き → タグ設定 → 公開」を自動で繰り返します。

---

## ⚠️ 注意：連続投稿時のエラーについて

> **「投稿に失敗しました。申し訳ございませんが、しばらく時間をあけて編集画面からやり直してください。」**

連続して投稿を繰り返すと、Note側のレート制限によりこのエラーが表示される場合があります。

**この場合は、以下の手順で対処してください。**

1. プログラムを終了する
2. **30分〜3時間程度** 時間を空ける
3. 本プログラムを再度実行する

このエラーはプログラムの不具合ではなく、Note側の制限によるものです。時間を空けることで解消されます。

---

## よくあるエラー

**「node コマンドが見つかりません」**

Node.jsがインストールされていません。[Node.js公式サイト](https://nodejs.org/) からインストールしてください。

**ログイン画面から進まない**

ブラウザで手動ログインしてください。ログイン後は自動保存されます。

**「下書き記事が見つかりませんでした」**

Noteの下書き一覧に記事が存在しません。先に `node note-auto-post.js` を実行してください。

**Noteの画面でエラーになる**

Note側の画面構成が変更された可能性があります。最新版のプログラムへ更新してください。

---

## おすすめの使い方

初めて利用する場合は以下がおすすめです。

1. `NOTE_PUBLISH_MODE=draft` に設定
2. WordPressの記事を取得
3. Noteへ下書き保存
4. 内容を確認
5. 一括公開

この方法が最も安全です。

---

## 実行コマンドまとめ

```bash
# 記事取得
node wp-to-note.js

# Noteへ投稿
node note-auto-post.js

# 下書きを公開
node note-publish-one.js
```
