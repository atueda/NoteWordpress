const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// .env を読み込む
const envPath = path.join(__dirname, ".env");
const env = fs.existsSync(envPath)
  ? Object.fromEntries(
      fs.readFileSync(envPath, "utf8")
        .split("\n")
        .filter(l => l.trim() && !l.startsWith("#"))
        .map(l => l.split("=").map(s => s.trim()))
    )
  : {};

const NOTE_EMAIL = env.NOTE_EMAIL;
const NOTE_PASSWORD = env.NOTE_PASSWORD;
const TAGS = (env.NOTE_TAGS || "").split(",").map(t => t.trim()).filter(Boolean);

const config = {
  headless: false,
  slowMo: 100,
  timeout: 60000,
  maxPublishCount: 500,
};

async function clickButton(page, text) {
  const button = page.locator("button").filter({ hasText: text }).first();
  await button.waitFor({ timeout: config.timeout });
  await button.scrollIntoViewIfNeeded();
  await button.click({ force: true });
}

async function login(page) {
  console.log("ログイン画面を開きます...");
  await page.goto("https://note.com/login", { waitUntil: "domcontentloaded" });
  const emailInput = page.locator("#email");
  try {
    await emailInput.waitFor({ timeout: 5000 });
  } catch {
    console.log("すでにログイン済みです");
    return;
  }
  await emailInput.fill(NOTE_EMAIL);
  await page.locator("#password").fill(NOTE_PASSWORD);
  await page.locator("button").filter({ hasText: "ログイン" }).first().click({ force: true });
  await page.waitForURL(/note\.com\/(?!login)/, { timeout: config.timeout });
  console.log("ログイン後URL:", page.url());
}

async function closeAchievementPopup(page) {
  try {
    const popup = page.locator(".o-userPopup, [class*='achievement'], [class*='Achievement']").first();
    const btn = page.locator('button[aria-label="閉じる"]').first();
    await btn.waitFor({ timeout: 3000 });
    await btn.click({ force: true });
    console.log("アチーブメントポップアップを閉じました");
  } catch (e) {}
}

async function closeShareDialog(page) {
  console.log("シェアダイアログを閉じます...");
  // 「記事をシェアしてみましょう」ダイアログの×ボタン
  // data-v属性付きのbutton[aria-label="閉じる"]
  const selectors = [
    'button[data-type="close"]',
    '[class*="ReactModal__Content"] button',
    '[class*="PublishedModal"] button',
    'button[aria-label="閉じる"]',  // 完全一致（"検索フォームを閉じる"等を除外）
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).filter({ hasNot: page.locator('[class*="navbar"], [class*="Navbar"], [class*="search"], [class*="Search"]') }).first();
    if ((await btn.count()) > 0) {
      await btn.click({ force: true });
      await page.waitForTimeout(500);
      return;
    }
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}

async function addTags(page) {
  console.log("ハッシュタグを設定します...");
  const tagInput = page.locator(
    'input[aria-owns="hashtag-search-result"], input[role="combobox"], input[placeholder*="ハッシュタグ"]'
  ).first();
  await tagInput.waitFor({ timeout: config.timeout });
  for (const tag of TAGS) {
    console.log(`タグ追加: #${tag}`);
    await tagInput.click({ force: true });
    await tagInput.fill("");
    await page.keyboard.type(tag, { delay: 80 });
    await page.waitForTimeout(600);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
  }
}

async function openNotesList(page) {
  console.log("記事一覧を開きます...");
  await page.goto("https://note.com/notes?status=draft", { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
}

async function openFirstDraft(page) {
  console.log("下書き記事を探します...");

  const rows = page.locator("li");
  const count = await rows.count();
  console.log(`記事行数: ${count}`);

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const text = await row.textContent();
    if (!text || text.includes("公開中") || !text.includes("下書き")) continue;

    console.log("下書き記事を発見しました");

    // aria-label から記事IDを取得 (例: "記事タイトル を編集" や記事タイトルそのもの)
    const noteId = await row.evaluate(el => {
      // a[href*="/n/"] からIDを取得
      const a = el.querySelector('a[href*="/n/"]');
      if (a) {
        const m = a.getAttribute("href").match(/\/n\/(n[a-z0-9]+)/);
        if (m) return m[1];
      }
      // button の aria-label から取得
      for (const btn of el.querySelectorAll("button[aria-label]")) {
        const m = btn.getAttribute("aria-label").match(/(n[a-z0-9]{10,})/);
        if (m) return m[1];
      }
      // visually-hidden span のテキストからIDを含むリンクを探す
      const spans = el.querySelectorAll("span");
      for (const span of spans) {
        const m = span.textContent.match(/(n[a-z0-9]{10,})/);
        if (m) return m[1];
      }
      return null;
    });

    if (!noteId) {
      // IDが取れなければ span[aria-label] や button から記事タイトルでIDを推測できないのでスキップ
      console.log("記事IDを取得できませんでした。スキップします");
      continue;
    }

    const editorUrl = `https://editor.note.com/notes/${noteId}/edit/`;
    console.log(`エディタへ遷移: ${editorUrl}`);
    await page.goto(editorUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(3000);
    console.log("現在URL:", page.url());
    if (page.url().includes("/notes/")) return true;
  }

  console.log("下書き記事が見つかりませんでした");
  return false;
}

// noteIdを指定してエディタから公開まで行う。nullなら現在ページから続行。成功:true 失敗:false
async function publishByNoteId(page, noteId) {
  if (noteId) {
    const editorUrl = `https://editor.note.com/notes/${noteId}/edit/`;
    console.log(`エディタへ遷移: ${editorUrl}`);
    await page.goto(editorUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(3000);
  }

  console.log("公開に進むをクリックします...");
  await clickButton(page, "公開に進む");
  await page.waitForURL(/\/notes\/.*\/publish/, { timeout: config.timeout }).catch(() => {});
  await page.waitForTimeout(3000);

  await addTags(page);

  let failed = false;
  const dialogHandler = async (dialog) => {
    console.log(`ダイアログ検知: "${dialog.message()}"`);
    if (dialog.message().includes("失敗")) failed = true;
    await dialog.accept();
  };
  page.once("dialog", dialogHandler);

  console.log("投稿するをクリックします...");
  await clickButton(page, "投稿する");

  await Promise.race([
    page.waitForURL(url => !url.includes("/publish"), { timeout: 15000 }),
    page.waitForSelector('button[aria-label="閉じる"], button[data-type="close"]', { timeout: 15000 }),
    page.waitForTimeout(15000),
  ]).catch(() => {});
  await page.waitForTimeout(2000);

  if (failed) {
    console.log("投稿失敗（システムエラー）");
    return false;
  }

  await closeAchievementPopup(page);
  const hasDialog = await page.locator('button[aria-label="閉じる"], button[data-type="close"]').first().isVisible().catch(() => false);
  if (hasDialog) {
    await closeShareDialog(page);
  } else {
    console.log("シェアダイアログはありませんでした");
  }
  await page.waitForTimeout(1000);
  return true;
}

async function publishAllDrafts(page) {
  let publishedCount = 0;
  const failedIds = [];  // システムエラーで失敗した記事IDを記録

  while (publishedCount < config.maxPublishCount) {
    console.log("----------------------------------------");
    console.log(`公開処理 ${publishedCount + 1} 件目`);
    console.log("----------------------------------------");

    await openNotesList(page);
    const found = await openFirstDraft(page);  // エディタへ遷移済み

    if (!found) {
      console.log("下書きがなくなりました");
      break;
    }

    // 遷移後のURLからnoteIdを取得
    const currentUrl = page.url();
    const noteIdMatch = currentUrl.match(/\/notes\/(n[a-z0-9]+)/);
    const noteId = noteIdMatch ? noteIdMatch[1] : null;
    console.log(`noteId: ${noteId}, URL: ${currentUrl}`);

    // エディタにいるのでそのまま公開処理
    const success = await publishByNoteId(page, null);  // nullで現在ページから続行
    if (success) {
      publishedCount++;
      console.log(`累計: ${publishedCount} 件公開`);
    } else {
      console.log("");
      console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
      console.log("!!  NOTE システムエラーが発生しました  !!");
      console.log("!!  プログラムを終了します            !!");
      console.log(`!!  失敗した記事ID: ${noteId ?? "不明"}  `);
      console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
      console.log("");
      return;
    }

    console.log("記事一覧へ戻ります...");
    await page.goto("https://note.com/notes?status=draft", { waitUntil: "networkidle" });
    await page.waitForTimeout(3000);
  }

  console.log(`完了: ${publishedCount} 件公開`);
  if (failedIds.length > 0) {
    console.log(`最終的に失敗した記事ID: ${failedIds.join(", ")}`);
  }
}

async function main() {
  const context = await chromium.launchPersistentContext("./note-browser-profile", {
    headless: config.headless,
    slowMo: config.slowMo,
    viewport: null,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeout);
  try {
    await login(page);
    await publishAllDrafts(page);
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
