#!/usr/bin/env node
/**
 * WordPress → Note 移行スクリプト
 * 使い方: node wp-to-note.js
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

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
  wpUrl: env.WP_URL,
  perPage: Number(env.WP_PER_PAGE),
  maxPages: Number(env.WP_MAX_PAGES),
  outputDir: env.WP_OUTPUT_DIR,
  format: 'individual', // 'individual'=記事ごとにファイル / 'single'=1ファイルにまとめる
  category: '',      // カテゴリスラッグでフィルタ (空白=全記事)
  search: '',        // キーワード検索 (空白=なし)
};
// ==========================

function request(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'wp-to-note-script/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch(e) {
          reject(new Error(`JSON parse error: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => '#'.repeat(n) + ' ')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatArticle(article) {
  const title = stripHtml(article.title.rendered);
  const date = new Date(article.date).toLocaleDateString('ja-JP');
  const url = article.link;
  const content = stripHtml(article.content.rendered);
  const categories = article._embedded?.['wp:term']?.[0]?.map(t => t.name).join(', ') || '';
  const tags = article._embedded?.['wp:term']?.[1]?.map(t => t.name).join(', ') || '';

  let text = `# ${title}\n\n`;
  text += `公開日：${date}\n`;
  text += `元記事URL：${url}\n`;
  if (categories) text += `カテゴリ：${categories}\n`;
  if (tags) text += `タグ：${tags}\n`;
  text += `\n---\n\n`;
  text += content;
  text += `\n\n---\n\nこの記事はもともと ${url} に掲載したものです。`;
  return text;
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

async function fetchAllArticles() {
  let allArticles = [];
  let page = 1;

  while (page <= CONFIG.maxPages) {
    let url = `${CONFIG.wpUrl}/wp-json/wp/v2/posts?per_page=${CONFIG.perPage}&page=${page}&_embed`;
    if (CONFIG.search) url += `&search=${encodeURIComponent(CONFIG.search)}`;
    if (CONFIG.category) url += `&categories_slug=${encodeURIComponent(CONFIG.category)}`;

    process.stdout.write(`  ページ ${page} を取得中...`);
    try {
      const res = await request(url);
      if (res.status === 400 || (Array.isArray(res.body) && res.body.length === 0)) {
        console.log(' (記事なし、終了)');
        break;
      }
      if (!Array.isArray(res.body)) {
        console.log(`\nAPIエラー: ${JSON.stringify(res.body)}`);
        break;
      }
      console.log(` ${res.body.length}件取得`);
      allArticles = allArticles.concat(res.body);
      if (res.body.length < CONFIG.perPage) break;
      page++;
    } catch(e) {
      console.log(`\nエラー: ${e.message}`);
      break;
    }
  }
  return allArticles;
}

async function main() {
  console.log('=== WordPress → Note 移行スクリプト ===\n');
  console.log(`対象サイト: ${CONFIG.wpUrl}`);
  console.log(`出力先: ${CONFIG.outputDir}/\n`);

  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }

  console.log('記事を取得中...');
  const articles = await fetchAllArticles();

  if (articles.length === 0) {
    console.log('\n記事が取得できませんでした。');
    return;
  }

  console.log(`\n合計 ${articles.length} 件取得完了\n`);
  console.log('ファイルを生成中...');

  if (CONFIG.format === 'individual') {
    articles.forEach((article, i) => {
      const title = stripHtml(article.title.rendered);
      const filename = `${String(i + 1).padStart(3, '0')}_${sanitizeFilename(title)}.txt`;
      const filepath = path.join(CONFIG.outputDir, filename);
      fs.writeFileSync(filepath, formatArticle(article), 'utf8');
      console.log(`  [${i + 1}/${articles.length}] ${filename}`);
    });
  } else {
    const allText = articles.map(formatArticle).join('\n\n' + '='.repeat(60) + '\n\n');
    const filepath = path.join(CONFIG.outputDir, 'all-articles.txt');
    fs.writeFileSync(filepath, allText, 'utf8');
    console.log(`  → ${filepath}`);
  }

  // インデックスファイル生成
  const indexLines = ['# 記事一覧\n'];
  articles.forEach((a, i) => {
    const title = stripHtml(a.title.rendered);
    const date = new Date(a.date).toLocaleDateString('ja-JP');
    indexLines.push(`${i + 1}. [${date}] ${title}`);
    indexLines.push(`   ${a.link}`);
  });
  fs.writeFileSync(path.join(CONFIG.outputDir, '_index.txt'), indexLines.join('\n'), 'utf8');

  console.log(`\n✓ 完了！`);
  console.log(`  出力先: ${path.resolve(CONFIG.outputDir)}`);
  console.log(`  ファイル数: ${articles.length} 記事 + _index.txt`);
  console.log('\n--- Noteへの貼り付け手順 ---');
  console.log('1. note.com でノートを新規作成');
  console.log('2. 各 .txt ファイルを開いてコピー');
  console.log('3. Noteのエディタに貼り付け');
  console.log('4. タイトルとカバー画像を設定して公開');
}

main().catch(e => {
  console.error('予期せぬエラー:', e.message);
  process.exit(1);
});
