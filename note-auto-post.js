#!/usr/bin/env node
/**
 * Note 自動投稿スクリプト
 *
 * セットアップ:
 *   npm install playwright
 *   npx playwright install chromium
 *
 * 使い方:
 *   node note-auto-post.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

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

// ========== 設定 ==========
const CONFIG = {
  noteExportDir: env.WP_OUTPUT_DIR || './note-export',
  publishMode: env.NOTE_PUBLISH_MODE || 'publish',  // 'draft'=下書き保存 / 'publish'=即公開
  headless: false,                  // false=ブラウザを表示(推奨) / true=バックグラウンド実行
  delayMs: 2000,                    // 投稿間の待機時間(ms) 短くしすぎるとBANされる可能性あり
  startFrom: 1,                     // 何番目のファイルから開始するか（途中再開用）
};
// ==========================

const NOTE_URL = 'https://note.com';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseArticleFile(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  const lines = raw.split('\n');

  // タイトル: 1行目の `# ` を除去
  const titleLine = lines[0] || '';
  const title = titleLine.replace(/^#\s*/, '').trim();

  // 区切り `---` 以降を本文とする
  const sepIndex = lines.findIndex(l => l.trim() === '---');
  const body = sepIndex !== -1
    ? lines.slice(sepIndex + 1).join('\n').trim()
    : lines.slice(1).join('\n').trim();

  return { title, body };
}

function getArticleFiles(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`フォルダが見つかりません: ${dir}\n先に wp-to-note.js を実行してください。`);
  }
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.txt') && !f.startsWith('_'))
    .sort()
    .map(f => path.join(dir, f));
}

async function login(page, email, password) {
  console.log('  Noteにログイン中...');
  await page.goto(`${NOTE_URL}/login`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#email', { timeout: 30000 });
  await sleep(1000);

  // 人間らしく1文字ずつ入力
  await page.click('#email');
  await page.type('#email', email, { delay: 80 });
  await sleep(500);
  await page.click('#password');
  await page.type('#password', password, { delay: 80 });
  await sleep(800);

  await page.click('button.a-button:has-text("ログイン")');

  // ログイン完了を待つ（最大15秒、URLが/loginでなくなればOK）
  await sleep(3000);
  const currentUrl = page.url();
  if (currentUrl.includes('/login')) {
    throw new Error('ログインに失敗しました。メールアドレス/パスワードを確認してください。');
  }

  console.log('  ✓ ログイン成功:', currentUrl);
}

async function postArticle(page, title, body, mode) {
  // 新規作成ページへ
  await page.goto(`${NOTE_URL}/notes/new`, { waitUntil: 'networkidle' });
  await sleep(2000);

  // タイトル入力
  const titleSel = '[data-placeholder="タイトル"], .title-input, textarea[placeholder*="タイトル"]';
  await page.waitForSelector(titleSel, { timeout: 30000 });
  await page.click(titleSel);
  await page.fill(titleSel, title);

  // 本文エリアをクリック（プレースホルダーテキストの要素を探してクリック）
  await sleep(800);
  const bodyClicked = await page.evaluate(() => {
    // Noteのエディタ本文エリアを探す
    const candidates = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    // タイトル以外の最初のcontenteditable
    const bodyEl = candidates.find(el =>
      !el.closest('[data-placeholder*="タイトル"]') &&
      !el.getAttribute('data-placeholder')?.includes('タイトル')
    );
    if (bodyEl) { bodyEl.click(); bodyEl.focus(); return true; }
    return false;
  });

  if (!bodyClicked) {
    // プレースホルダーをクリックして本文エリアをアクティブにする
    await page.click('text=たのしかった旅行について').catch(() => {});
    await page.click('[class*="placeholder"], [class*="body"], p').catch(() => {});
  }
  await sleep(500);

  // クリップボードに本文をセットしてCtrl+Vで貼り付け
  await page.evaluate((text) => {
    // クリップボードAPIで直接セット
    return navigator.clipboard.writeText(text).catch(() => {
      // fallback: 隠しtextareaでコピー
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
  }, body);

  await sleep(300);
  // Cmd+V (Mac) で貼り付け
  await page.keyboard.press('Meta+v');
  await sleep(1500);

  if (mode === 'draft') {
    // 下書き保存ボタンを探してクリック
    const draftBtn = page.locator('button:has-text("下書き保存"), button:has-text("保存")').first();
    await draftBtn.waitFor({ timeout: 30000 });
    await draftBtn.click();
    await sleep(1500);
    console.log(`    → 下書き保存: ${title}`);
  } else {
    // 公開に進む → タグ設定 → 投稿する
    console.log('    公開に進むをクリックします...');
    const proceedBtn = page.locator('button').filter({ hasText: '公開に進む' }).first();
    await proceedBtn.waitFor({ timeout: 30000 });
    await proceedBtn.scrollIntoViewIfNeeded();
    await proceedBtn.click({ force: true });
    await page.waitForURL(/\/notes\/.*\/publish/, { timeout: 60000 }).catch(() => {});
    await sleep(3000);

    // ハッシュタグ設定
    const TAGS = (process.env.NOTE_TAGS || '').split(',').map(t => t.trim()).filter(Boolean);
    if (TAGS.length > 0) {
      console.log('    ハッシュタグを設定します...');
      const tagInput = page.locator(
        'input[aria-owns="hashtag-search-result"], input[role="combobox"], input[placeholder*="ハッシュタグ"]'
      ).first();
      await tagInput.waitFor({ timeout: 60000 });
      for (const tag of TAGS) {
        await tagInput.click({ force: true });
        await tagInput.fill('');
        await page.keyboard.type(tag, { delay: 80 });
        await sleep(600);
        await page.keyboard.press('Enter');
        await sleep(600);
      }
    }

    // 投稿する
    console.log('    投稿するをクリックします...');
    const submitBtn = page.locator('button').filter({ hasText: '投稿する' }).first();
    await submitBtn.waitFor({ timeout: 30000 });
    await submitBtn.scrollIntoViewIfNeeded();
    await submitBtn.click({ force: true });

    // 完了待機（/publishから離れるかダイアログ出現まで）
    await Promise.race([
      page.waitForURL(url => !url.includes('/publish'), { timeout: 15000 }),
      page.waitForSelector('button[aria-label="閉じる"], button[data-type="close"]', { timeout: 15000 }),
      sleep(15000),
    ]).catch(() => {});
    await sleep(2000);

    // シェアダイアログを閉じる
    const closeBtn = page.locator('button[aria-label="閉じる"], button[data-type="close"]').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ force: true });
      await sleep(500);
    }

    console.log(`    → 公開済み: ${title}`);
  }
}

async function main() {
  console.log('=== Note 自動投稿スクリプト ===\n');

  // ログイン情報を入力
  const email = await ask('Noteのメールアドレス: ');
  const password = await ask('Noteのパスワード: ');
  console.log('');

  // 記事ファイル一覧
  const files = getArticleFiles(CONFIG.noteExportDir);
  const targetFiles = files.slice(CONFIG.startFrom - 1);

  console.log(`投稿対象: ${targetFiles.length} 件 (全${files.length}件中)`);
  console.log(`モード: ${CONFIG.publishMode === 'draft' ? '下書き保存' : '即公開'}\n`);

  const confirm = await ask('開始しますか？ (y/n): ');
  if (confirm.toLowerCase() !== 'y') {
    console.log('キャンセルしました。');
    return;
  }

  const browser = await chromium.launch({ headless: CONFIG.headless });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    locale: 'ja-JP',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();

  try {
    await login(page, email, password);
    console.log('');

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < targetFiles.length; i++) {
      const file = targetFiles[i];
      const fileNum = CONFIG.startFrom + i;
      const filename = path.basename(file);
      console.log(`[${fileNum}/${files.length}] ${filename}`);

      try {
        const { title, body } = parseArticleFile(file);
        await postArticle(page, title, body, CONFIG.publishMode);
        successCount++;

        // 進捗を記録（途中再開用）
        fs.writeFileSync('./note-post-progress.txt', String(fileNum + 1), 'utf8');

        // 次の投稿まで待機
        if (i < targetFiles.length - 1) {
          await sleep(CONFIG.delayMs);
        }
      } catch(e) {
        console.error(`    ✗ エラー: ${e.message}`);
        failCount++;
        // エラーが続く場合は停止
        if (failCount >= 3) {
          console.error('\n連続エラーが3件発生したため停止します。');
          console.error(`途中再開する場合は startFrom を ${fileNum + 1} に変更してください。`);
          break;
        }
      }
    }

    console.log(`\n=== 完了 ===`);
    console.log(`成功: ${successCount} 件 / 失敗: ${failCount} 件`);

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error('\n予期せぬエラー:', e.message);
  process.exit(1);
});
