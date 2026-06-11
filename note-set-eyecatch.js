const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const os = require('os');

// .env を読み込む
const envPath = path.join(__dirname, '.env');
const env = fs.existsSync(envPath)
  ? Object.fromEntries(
      fs.readFileSync(envPath, 'utf8')
        .split('\n')
        .filter(l => l.trim() && !l.startsWith('#'))
        .map(l => l.split('=').map(s => s.trim()))
    )
  : {};

const WP_URL = (env.WP_URL || 'https://atueda.com').replace(/\/$/, '');

const INDEX_FILE = path.join(__dirname, 'note-export', '_index.txt');
const TEMP_DIR = path.join(__dirname, 'temp-images');
const PROGRESS_CSV = path.join(__dirname, 'eyecatch-progress.csv');

const config = {
  headless: false,
  slowMo: 100,
  timeout: 60000,
  // .env の EYECATCH_PUBLISH_MODE で制御（draft / publish）
  publishMode: env.EYECATCH_PUBLISH_MODE || 'publish',
  // .env の EYECATCH_MAX_COUNT で制御（数字 or Infinity）
  maxCount: env.EYECATCH_MAX_COUNT === 'Infinity' || !env.EYECATCH_MAX_COUNT
    ? Infinity
    : parseInt(env.EYECATCH_MAX_COUNT, 10),
};

// --- CSV進捗管理 ---

function loadProgress() {
  if (!fs.existsSync(PROGRESS_CSV)) return {};
  const lines = fs.readFileSync(PROGRESS_CSV, 'utf8').split('\n').slice(1); // ヘッダ除外
  const result = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const [url, status] = line.split(',').map(s => s.trim());
    if (url) result[url] = status;
  }
  return result;
}

function saveProgress(progress) {
  const header = 'url,status';
  const rows = Object.entries(progress).map(([url, status]) => `${url},${status}`);
  fs.writeFileSync(PROGRESS_CSV, [header, ...rows].join('\n') + '\n', 'utf8');
}

function markProgress(progress, url, status) {
  progress[url] = status;
  saveProgress(progress);
}

// _index.txt から WP_URL で始まるURLを順番に抽出
function extractUrls(indexFile) {
  const text = fs.readFileSync(indexFile, 'utf8');
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith(WP_URL + '/'));
}

// URLの末尾パスセグメントをファイル名用のslugに変換
function extractSlug(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const raw = decodeURIComponent(parts[parts.length - 1] || 'article');
    return raw.replace(/[^\w぀-鿿]/g, '_').slice(0, 80);
  } catch {
    return 'article';
  }
}

// 画像URLをダウンロード（リダイレクト対応、最大5リダイレクト）
function downloadImage(url, destPath, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('リダイレクト上限超過'));
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        return downloadImage(res.headers.location, destPath, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
    }).on('error', (err) => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
  });
}

// セレクタに対してリトライ付きでクリック（最大3回・スクロール・待機）
async function retryClick(page, selector, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const el = page.locator(selector).first();
      await el.waitFor({ timeout: 5000 });
      await el.scrollIntoViewIfNeeded();
      await el.click({ force: true });
      return true;
    } catch (e) {
      if (i < maxRetries - 1) {
        console.log(`  リトライ ${i + 1}/${maxRetries}: ${selector}`);
        await page.waitForTimeout(1000);
      }
    }
  }
  return false;
}

// WordPress REST API からスラッグでタイトルとアイキャッチ画像URLを取得する。
// Playwrightを使わないため Cloudflare bot 検知を回避できる。
async function fetchWordPressInfo(_page, wpPageUrl) {
  console.log(`記事取得開始（API）: ${wpPageUrl}`);

  // URLの末尾スラッグを取り出してAPIで検索
  const slug = decodeURIComponent(
    new URL(wpPageUrl).pathname.replace(/\/$/, '').split('/').pop()
  );

  const apiUrl = `${WP_URL}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_fields=title,yoast_head_json,featured_media,_links&_embed=wp:featuredmedia&per_page=1`;
  console.log(`API: ${apiUrl}`);

  const res = await new Promise((resolve, reject) => {
    const client = apiUrl.startsWith('https') ? https : http;
    client.get(apiUrl, { headers: { 'User-Agent': 'wp-to-note/1.0' } }, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSONパースエラー: ${data.slice(0, 100)}`)); }
      });
    }).on('error', reject);
  });

  if (!Array.isArray(res) || res.length === 0) {
    console.log(`API: 記事が見つかりませんでした (slug=${slug})`);
    return { title: '', imageUrl: null };
  }

  const post = res[0];
  const title = post.title?.rendered
    ? post.title.rendered.replace(/<[^>]+>/g, '').trim()
    : '';

  // アイキャッチ画像URLの優先順位:
  // 1. Yoast SEO の og:image（最も確実）
  // 2. _embedded の featuredmedia
  let imageUrl =
    post.yoast_head_json?.og_image?.[0]?.url ||
    post._embedded?.['wp:featuredmedia']?.[0]?.source_url ||
    null;

  console.log(`タイトル取得: ${title}`);
  console.log(`画像URL: ${imageUrl}`);
  return { title, imageUrl };
}

// Note一覧ページから a[href*="/n/"] を走査してタイトルに一致するnoteIdを返す（元の動作確認済みロジック）
async function findNoteId(page, title) {
  const shortTitle = title.slice(0, 15);

  // 第一候補: リンクテキストが完全一致または含む
  const allLinks = page.locator('a[href*="/n/"]');
  const linkCount = await allLinks.count();
  for (let i = 0; i < linkCount; i++) {
    const link = allLinks.nth(i);
    const text = (await link.textContent().catch(() => '')).trim();
    if (text === title || text.includes(title)) {
      const href = await link.getAttribute('href').catch(() => null);
      const m = href?.match(/\/n\/(n[a-z0-9]+)/);
      if (m) {
        console.log(`Note記事発見（リンク一致）: ${m[1]}`);
        return m[1];
      }
    }
  }

  // 第二候補: li カード内テキストに含まれる
  const cards = page.locator('li');
  const cardCount = await cards.count();
  for (let i = 0; i < cardCount; i++) {
    const card = cards.nth(i);
    const text = (await card.textContent().catch(() => ''));
    if (text.includes(title)) {
      const href = await card.locator('a[href*="/n/"]').first().getAttribute('href').catch(() => null);
      const m = href?.match(/\/n\/(n[a-z0-9]+)/);
      if (m) {
        console.log(`Note記事発見（カード一致）: ${m[1]}`);
        return m[1];
      }
    }
  }

  // 第三候補: 先頭15文字で部分一致
  for (let i = 0; i < linkCount; i++) {
    const link = allLinks.nth(i);
    const text = (await link.textContent().catch(() => '')).trim();
    if (text.includes(shortTitle)) {
      const href = await link.getAttribute('href').catch(() => null);
      const m = href?.match(/\/n\/(n[a-z0-9]+)/);
      if (m) {
        console.log(`Note記事発見（部分一致）: ${m[1]}`);
        return m[1];
      }
    }
  }

  return null;
}

// Note一覧を開き、スクロールしながらnoteIdを探す。
// 見つかったら editor.note.com のエディタURLへ直接遷移する（動作確認済みのアプローチ）。
// noteIdが取れない場合のフォールバックとして「...」→「編集」クリック方式も試みる。
async function openNoteEditor(page, title) {
  console.log(`Note記事を検索: ${title}`);
  await page.goto('https://note.com/notes', { waitUntil: 'networkidle', timeout: config.timeout });
  await page.waitForTimeout(2000);

  let noteId = null;

  // 最大8回スクロールして全記事を読み込みながらnoteIdを探す
  for (let scroll = 0; scroll < 12; scroll++) {
    noteId = await findNoteId(page, title);
    if (noteId) break;

    const prevHeight = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === prevHeight) break;
  }

  // noteIdが取れた → エディタURLへ直接遷移（元の動作確認済みロジック）
  if (noteId) {
    const editorUrl = `https://editor.note.com/notes/${noteId}/edit/`;
    console.log(`エディタへ遷移: ${editorUrl}`);
    await page.goto(editorUrl, { waitUntil: 'networkidle', timeout: config.timeout });
    await page.waitForTimeout(3000);
    return true;
  }

  // フォールバック: noteIdが取れない場合は「...」→「編集」クリック方式を試みる
  console.log('noteId取得失敗。UIクリック方式を試みます...');
  await page.goto('https://note.com/notes', { waitUntil: 'networkidle', timeout: config.timeout });
  await page.waitForTimeout(2000);

  const shortTitle = title.slice(0, 20);
  const cards = page.locator('li');
  const count = await cards.count();

  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    const text = (await card.textContent().catch(() => '')).trim();
    if (!text.includes(title) && !text.includes(shortTitle)) continue;

    console.log(`Note記事発見（UI方式）: ${title}`);

    // スクリーンショットより aria-label="その他" の「...」ボタン
    const moreBtn = card.locator('button[aria-label="その他"]').first();
    if (await moreBtn.count() === 0) continue;

    await moreBtn.scrollIntoViewIfNeeded();
    await moreBtn.click({ force: true });
    await page.waitForTimeout(1000);

    // スクリーンショットより class="m-basicBalloonList__button" の「編集」ボタン
    const editBtn = page.locator('.m-basicBalloonList__button').filter({ hasText: '編集' }).first();
    if (await editBtn.count() > 0) {
      await editBtn.click({ force: true });
    } else {
      const fallback = page.locator('button').filter({ hasText: '編集' }).first();
      if (await fallback.count() > 0) {
        await fallback.click({ force: true });
      } else {
        await page.keyboard.press('Escape');
        continue;
      }
    }

    await page.waitForTimeout(3000);
    const url = page.url();
    if (url.includes('editor.note.com') || (url.includes('/notes/') && url.includes('edit'))) {
      console.log(`エディタへ遷移: ${url}`);
      return true;
    }
  }

  console.log(`Note記事が見つかりませんでした: ${title}`);
  return false;
}

// Note一覧で記事を探し、アイキャッチ画像の有無を確認する。
// 画像未設定の記事はそのカードをクリックしてエディタへ遷移する。
// 一覧ではタイトルが先頭約20文字で切れるため、先頭20文字で検索する。
// 戻り値: 'skipped'=設定済み / 'opened'=エディタを開いた / 'notfound'=記事が見つからない
async function checkAndOpenEditor(page, title) {
  const shortTitle = title.slice(0, 20);

  for (let scroll = 0; scroll < 12; scroll++) {
    const cards = page.locator('li');
    const count = await cards.count();

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const text = (await card.textContent().catch(() => '')).trim();
      if (!text.includes(shortTitle)) continue;

      // 画像有無をサムネイルで判定
      const thumbImg = card.locator('div.shrink-0.self-center.pl-3 img[data-nimg]');
      const hasEyecatch = (await thumbImg.count()) > 0;
      console.log(`サムネイル確認（一覧）: ${hasEyecatch ? '設定済み' : '未設定'}`);

      if (hasEyecatch) return 'skipped';

      // 未設定 → このカードのリンクをクリックしてエディタへ遷移
      const href = await card.locator('a[href*="/n/"]').first().getAttribute('href').catch(() => null);
      const m = href?.match(/\/n\/(n[a-z0-9]+)/);
      if (!m) {
        console.log('記事IDを取得できませんでした');
        continue;
      }
      const noteId = m[1];
      const editorUrl = `https://editor.note.com/notes/${noteId}/edit/`;
      console.log(`エディタへ遷移: ${editorUrl}`);
      await page.goto(editorUrl, { waitUntil: 'networkidle', timeout: config.timeout });
      await page.waitForTimeout(3000);
      return 'opened';
    }

    const prevHeight = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === prevHeight) break;
  }

  console.log(`記事が一覧に見つかりませんでした: ${title}`);
  return 'notfound';
}

// macOS ファイル選択ダイアログで temp-images サイドバー項目をクリックし、
// 指定ファイルを選択して「開く」ボタンを押す。
// keystroke（Accessibility権限必要）を使わず click のみで操作する。
function selectFileWithOsascript(absolutePath) {
  const filename = path.basename(absolutePath);

  // ダイアログを持つプロセスを探す（Chromium または chrome）
  const script = `
set targetFile to "${filename}"
set found to false

-- ダイアログを持つプロセスを探す
repeat with procName in {"Chromium", "Google Chrome", "chromium"}
  if not found then
    try
      tell application "System Events"
        tell process procName
          -- シートまたはウィンドウ内の Open ダイアログを探す
          set dlg to missing value
          repeat with w in windows
            try
              set sh to sheet 1 of w
              set dlg to sh
              exit repeat
            end try
          end repeat
          if dlg is missing value then
            try
              set dlg to window 1
            end try
          end if

          if dlg is not missing value then
            -- サイドバー（outline 1）から "temp-images" を探してクリック
            try
              set sidebar to scroll area 1 of splitter group 1 of dlg
              set ol to outline 1 of sidebar
              set rowCount to count of rows of ol
              repeat with i from 1 to rowCount
                set r to row i of ol
                set rText to value of static text 1 of r
                if rText is "temp-images" then
                  click r
                  delay 1.0
                  set found to true
                  exit repeat
                end if
              end repeat
            end try

            -- ファイルリストからファイルを選択してクリック
            if found then
              try
                set fileList to scroll area 2 of splitter group 1 of dlg
                set ol2 to outline 1 of fileList
                set rowCount2 to count of rows of ol2
                repeat with j from 1 to rowCount2
                  set r2 to row j of ol2
                  set rText2 to value of static text 1 of r2
                  if rText2 is targetFile then
                    click r2
                    delay 0.5
                    exit repeat
                  end if
                end repeat
              end try

              -- 「開く」ボタンをクリック
              try
                click button "開く" of dlg
              on error
                try
                  click button "Open" of dlg
                end try
              end try
            end if
          end if
        end tell
      end tell
    end try
  end if
end repeat
`;

  try {
    execSync(`osascript << 'OSASCRIPT_EOF'\n${script}\nOSASCRIPT_EOF`, { timeout: 30000 });
  } catch (e) {
    console.error(`osascript エラー: ${e.message}`);
    throw e;
  }
}

// アイキャッチ画像をアップロードする。
// 方法A（推奨）: filechooser イベントを Promise.all でインターセプトし、setFiles でダイアログを回避する。
// 方法B（フォールバック）: macOS ダイアログが開いた場合、osascript の click で temp-images から選択する。
async function uploadEyecatch(page, imagePath) {
  const absoluteImagePath = path.resolve(imagePath);

  // STEP1: 「画像を追加」ボタンをクリックしてドロップダウンを開く
  console.log('「画像を追加」ボタンを待機中...');
  const addBtn = page.locator('button[aria-label="画像を追加"]').first();
  await addBtn.waitFor({ state: 'visible', timeout: config.timeout });
  console.log('「画像を追加」ボタンが見つかりました');
  await addBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await addBtn.click({ force: true });
  console.log('「画像を追加」ボタンをクリックしました');

  const uploadMenuItem = page.locator('button, li, [role="menuitem"]')
    .filter({ hasText: '画像をアップロード' })
    .first();
  await uploadMenuItem.waitFor({ timeout: 10000 });

  // 方法A: filechooser イベントをインターセプト（Playwright推奨・ダイアログ回避）
  // Promise.all で waitForEvent を登録してからクリックすることでインターセプトできる
  let uploaded = false;
  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      uploadMenuItem.click({ force: true }),
    ]);
    await fileChooser.setFiles(absoluteImagePath);
    console.log('filechooser 経由でファイルを設定しました');
    uploaded = true;
  } catch (e) {
    console.log(`filechooser インターセプト失敗: ${e.message}`);
  }

  // 方法B: ダイアログが開いてしまった場合 → osascript の click で操作
  if (!uploaded) {
    console.log('方法B: osascript でダイアログを操作します');
    await page.waitForTimeout(2000);
    selectFileWithOsascript(absoluteImagePath);
  }

  // トリミングポップアップのコンテナが出るのを待ってから「保存」をクリック
  // ※ Note エディタには「下書き保存」ボタンもあり hasText:'保存' では誤マッチするため
  //    /^保存$/ の完全一致を使う
  console.log('トリミングポップアップを待機...');
  try {
    // まずポップアップ本体（reactEasyCrop のコンテナ）が出るまで待つ
    await page.waitForSelector('[class*="reactEasyCrop"], [data-testid="container"]', {
      state: 'visible',
      timeout: 20000,
    });
    console.log('トリミングポップアップが表示されました');

    // テキストが「保存」と完全一致するボタンだけを選ぶ
    const saveBtn = page.locator('button').filter({ hasText: /^保存$/ }).first();
    await saveBtn.waitFor({ state: 'visible', timeout: 10000 });
    await saveBtn.click({ force: true });
    console.log('「保存」ボタンをクリックしました');
  } catch (e) {
    console.log(`トリミングポップアップが見つかりませんでした: ${e.message}`);
  }

  // エディタにアイキャッチ画像が反映されるのを待つ
  console.log('アイキャッチ画像の反映を待機中...');
  try {
    await page.waitForSelector('figure img[alt="eyecatch"]', { timeout: 30000 });
    console.log('アイキャッチ画像が反映されました');
  } catch (e) {
    // alt 属性なしのケースにも対応
    await Promise.race([
      page.waitForSelector('[class*="eyecatch"] img, figure img', { timeout: 15000 }),
      page.waitForTimeout(10000),
    ]).catch(() => {});
    console.log('アイキャッチ画像の反映確認（フォールバック）');
  }
}

// 画像設定後の保存処理。config.publishMode に応じて動作が変わる。
// 'draft'  : 下書き保存ボタンを押して終了（公開しない）
// 'publish': 「公開に進む」→「更新する/公開する」まで進む
async function publishUpdate(page) {
  if (config.publishMode === 'draft') {
    // 下書き保存: 「下書き保存」または Ctrl+S で保存
    const saved = await retryClick(page, 'button:has-text("下書き保存")');
    if (saved) {
      console.log('下書き保存完了');
    } else {
      // ボタンが見当たらない場合はキーボードショートカットで保存
      await page.keyboard.press('Meta+s');
      await page.waitForTimeout(2000);
      console.log('下書き保存完了（Cmd+S）');
    }
    return;
  }

  // publishMode === 'publish': 公開まで進む
  const proceedSelectors = [
    'button:has-text("公開に進む")',
    'button:has-text("更新")',
  ];
  let proceedClicked = false;
  for (const sel of proceedSelectors) {
    if (await retryClick(page, sel)) {
      proceedClicked = true;
      console.log(`クリック: ${sel}`);
      break;
    }
  }

  if (!proceedClicked) {
    throw new Error('公開に進むボタンが見つかりませんでした');
  }

  await page.waitForTimeout(3000);

  // 最終ボタン: 「更新する」「公開する」「投稿する」
  const finalSelectors = [
    'button:has-text("更新する")',
    'button:has-text("公開する")',
    'button:has-text("投稿する")',
  ];
  for (const sel of finalSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible({ timeout: 3000 })) {
        await btn.scrollIntoViewIfNeeded();
        await btn.click({ force: true });
        console.log(`更新完了: ${sel}`);
        await page.waitForTimeout(3000);
        break;
      }
    } catch {}
  }

  // シェアダイアログを閉じる（note-publish-one.js のパターンを流用）
  try {
    const closeBtn = page.locator('button[aria-label="閉じる"], button[data-type="close"]').first();
    if (await closeBtn.isVisible({ timeout: 3000 })) {
      await closeBtn.click({ force: true });
      await page.waitForTimeout(1000);
    }
  } catch {}
}

// 1記事分の処理: WP記事から画像取得 → 一覧で画像有無を確認 → 未設定ならエディタを開いてアップロード
// 戻り値: 'done'=アップロード完了 / 'skipped'=スキップ / 'failed'=エラー
async function processArticle(page, wpUrl) {
  const slug = extractSlug(wpUrl);
  const imagePath = path.join(TEMP_DIR, `${slug}.jpg`);

  // WordPress記事からタイトルと画像URL取得
  const { title, imageUrl } = await fetchWordPressInfo(page, wpUrl);

  if (!title) {
    console.log('タイトルが取得できませんでした。スキップします');
    return 'skipped';
  }
  if (!imageUrl) {
    console.log('アイキャッチ画像が見つかりませんでした。スキップします');
    return 'skipped';
  }

  // Note一覧で画像有無を確認し、未設定ならそのままエディタへ遷移する
  await page.goto('https://note.com/notes', { waitUntil: 'networkidle', timeout: config.timeout });
  await page.waitForTimeout(2000);

  const listResult = await checkAndOpenEditor(page, title);
  if (listResult === 'skipped') {
    console.log('画像設定済み。スキップします');
    return 'skipped';
  }
  if (listResult === 'notfound') {
    console.log(`Note記事が一覧に見つかりませんでした。スキップします: ${title}`);
    return 'skipped';
  }
  // listResult === 'opened': エディタへの遷移済み

  // 画像ダウンロード（既にキャッシュがあればスキップ）
  if (!fs.existsSync(imagePath)) {
    console.log(`画像ダウンロード中: ${imageUrl}`);
    await downloadImage(imageUrl, imagePath);
    console.log(`画像ダウンロード完了: ${imagePath}`);
  } else {
    console.log(`画像キャッシュ済み: ${imagePath}`);
  }

  // エディタ読み込み完了を待つ
  await page.waitForTimeout(2000);

  // アイキャッチ画像をアップロード
  await uploadEyecatch(page, imagePath);

  // 公開更新
  await publishUpdate(page);

  return 'done';
}

async function main() {
  console.log('=== Note アイキャッチ画像設定スクリプト ===');
  console.log(`対象サイト: ${WP_URL}`);
  console.log(`モード: ${config.publishMode === 'publish' ? '公開する' : '下書き保存（画像設定のみ）'}`);

  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  if (!fs.existsSync(INDEX_FILE)) {
    console.error(`_index.txt が見つかりません: ${INDEX_FILE}`);
    process.exit(1);
  }

  const urls = extractUrls(INDEX_FILE);
  console.log(`処理対象: ${urls.length} 件`);
  console.log(`上限: ${config.maxCount === Infinity ? '全件' : config.maxCount + ' 件'}\n`);

  const progress = loadProgress();
  const pendingUrls = urls.filter(u => progress[u] !== 'done');
  console.log(`未処理: ${pendingUrls.length} 件（処理済み: ${urls.length - pendingUrls.length} 件）\n`);

  const context = await chromium.launchPersistentContext('./note-browser-profile', {
    headless: config.headless,
    slowMo: config.slowMo,
    viewport: null,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeout);

  let done = 0, skipped = 0, failed = 0;

  try {
    for (let i = 0; i < pendingUrls.length; i++) {
      if (done >= config.maxCount) {
        console.log(`\n上限 ${config.maxCount} 件に達したため停止します`);
        break;
      }

      const url = pendingUrls[i];
      console.log('\n----------------------------------------');
      console.log(`[${i + 1}/${pendingUrls.length}] ${url}`);
      console.log('----------------------------------------');

      try {
        const result = await processArticle(page, url);
        if (result === 'done') {
          done++;
          markProgress(progress, url, 'done');
          console.log(`✓ 完了 (累計: ${done} 件)`);
        } else {
          skipped++;
          markProgress(progress, url, 'skipped');
        }
      } catch (e) {
        console.error(`エラー: ${e.message}`);
        failed++;
        markProgress(progress, url, 'failed');
      }

      if (i < pendingUrls.length - 1) {
        await page.waitForTimeout(1000);
      }
    }
  } finally {
    await context.close();
  }

  console.log('\n=== 完了 ===');
  console.log(`アップロード: ${done} 件 / スキップ: ${skipped} 件 / エラー: ${failed} 件`);
  console.log(`進捗ファイル: ${PROGRESS_CSV}`);
}

main().catch(e => {
  console.error('予期せぬエラー:', e.message);
  process.exit(1);
});
