/*
 * Build script for The New Mom Journal.
 *
 * index.html is the single source of truth: a client-rendered SPA with
 * 25 <template id="tpl-{slug}"> blocks (one per post) and matching
 * .nm-card entries in the listing panel.
 *
 * Problem this fixes: every post lives at the same URL (client-side JS
 * swaps which template is visible). Search engines and most AI/RAG
 * crawlers that don't execute JS only ever see one page, with a
 * generic/blank title, and no way to link to an individual article.
 *
 * This script generates a real, static blog/{slug}/index.html per post
 * (own <title>, meta description, canonical, OG/Twitter tags, and the
 * full article HTML incl. the existing schema.org FAQ markup) so every
 * post is independently crawlable and citable. It also extracts the
 * base64 images embedded in index.html into real image files (used by
 * both the static pages and the SPA), generates sitemap.xml + robots.txt,
 * and patches index.html's <head> metadata + card links in place.
 *
 * Run with: node build-blog.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SITE = 'https://www.reyforchildren.com';
const SRC = path.join(ROOT, 'index.html');

const CATEGORY_LABEL = {
  prep: 'Pregnancy & Prep',
  nurse: 'Breastfeeding & Nursing',
  newborn: 'Newborn Care',
  post: 'Postpartum Recovery',
};

function extFromMime(mime) {
  if (mime === 'jpeg') return 'jpg';
  if (mime === 'svg+xml') return 'svg';
  return mime;
}

function decodeDataUri(uri) {
  const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(uri);
  if (!m) return null;
  return { ext: extFromMime(m[1]), buffer: Buffer.from(m[2], 'base64') };
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .trim();
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
}

let raw = fs.readFileSync(SRC, 'utf8');

// ---------- 1. Extract shared <style> block (design system CSS) ----------
const bodyIdx = raw.indexOf('<body>');
const frameIdx = raw.indexOf('<div class="frame">');
const preFrame = raw.slice(bodyIdx + '<body>'.length, frameIdx);
const styleMatch = /<style>[\s\S]*?<\/style>/.exec(preFrame);
if (!styleMatch) throw new Error('shared <style> block not found');
const sharedStyle = styleMatch[0];

// ---------- 2. Extract cards ----------
const cardRe = /<a class="nm-card" href="#" data-article="([^"]+)" data-category="([^"]+)">([\s\S]*?)<\/a>/g;
const cards = {};
const cardOrder = [];
let cm;
while ((cm = cardRe.exec(raw))) {
  const [full, slug, category, inner] = cm;
  const imgMatch = /<img src="(data:image\/[^"]+)" alt="([^"]*)"/.exec(inner);
  const titleMatch = /<h2 class="nm-card__title">([\s\S]*?)<\/h2>/.exec(inner);
  const excerptMatch = /<p class="nm-card__excerpt">([\s\S]*?)<\/p>/.exec(inner);
  const metaMatch = /<div class="nm-card__meta">([\s\S]*?)<\/div>/.exec(inner);
  if (!imgMatch || !titleMatch || !excerptMatch || !metaMatch) {
    throw new Error('card parse failed for slug ' + slug);
  }
  cards[slug] = {
    full,
    category,
    imgDataUri: imgMatch[1],
    imgAlt: imgMatch[2],
    title: stripTags(titleMatch[1]),
    titleHtml: titleMatch[1],
    excerpt: stripTags(excerptMatch[1]),
    metaText: stripTags(metaMatch[1]),
  };
  cardOrder.push(slug);
}
if (cardOrder.length === 0) throw new Error('no cards found');

// ---------- 3. Extract templates ----------
const tplRe = /<template id="tpl-([^"]+)">([\s\S]*?)<\/template>/g;
const templates = {};
let tm;
while ((tm = tplRe.exec(raw))) {
  templates[tm[1]] = tm[2];
}

// ---------- 4. Prepare output dirs ----------
const blogDir = path.join(ROOT, 'blog');
const assetsDir = path.join(ROOT, 'assets');
fs.mkdirSync(blogDir, { recursive: true });
fs.mkdirSync(assetsDir, { recursive: true });

// ---------- 5. Extract homepage decorative images (hero + carousel) ----------
// These appear in preFrame/list-panel markup outside any card, tied to the
// homepage hero/carousel rather than a specific post.
let homeImgCounter = 0;
function extractHomeImage(dataUri) {
  const dec = decodeDataUri(dataUri);
  if (!dec) return null;
  homeImgCounter += 1;
  const name = `home-${homeImgCounter}.${dec.ext}`;
  fs.writeFileSync(path.join(assetsDir, name), dec.buffer);
  return `/assets/${name}`;
}

// ---------- 6. Per-post: extract hero + inline images, build static page ----------
const sitemapEntries = [];
const posts = [];

for (const slug of cardOrder) {
  const card = cards[slug];
  const tplInner = templates[slug];
  if (!tplInner) throw new Error('template missing for slug ' + slug);

  const postDir = path.join(blogDir, slug);
  fs.mkdirSync(postDir, { recursive: true });

  // Hero image comes from the card thumbnail (this is what the SPA's JS
  // passes into renderArticle() as heroSrc).
  const heroDec = decodeDataUri(card.imgDataUri);
  if (!heroDec) throw new Error('bad hero data uri for ' + slug);
  const heroFile = `hero.${heroDec.ext}`;
  fs.writeFileSync(path.join(postDir, heroFile), heroDec.buffer);
  const heroPath = `/blog/${slug}/${heroFile}`;

  // Inline content images embedded directly in the template (e.g. figure
  // breaks). The hero placeholder in the template has no src (class
  // "js-hero-img", filled by JS at runtime) so any data URI found here is
  // genuinely an inline content image.
  let inlineCounter = 0;
  let cleanedTplInner = tplInner.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, (m) => {
    const dec = decodeDataUri(m);
    if (!dec) return m;
    inlineCounter += 1;
    const fname = `inline-${inlineCounter}.${dec.ext}`;
    fs.writeFileSync(path.join(postDir, fname), dec.buffer);
    return `/blog/${slug}/${fname}`;
  });

  // Fill in the hero <img> for the static page (SPA keeps it dynamic via JS).
  const staticArticleHtml = cleanedTplInner.replace(
    '<img class="js-hero-img"',
    `<img class="js-hero-img" src="${heroPath}"`
  );

  const pageTitle = card.title;
  const description = truncate(card.excerpt, 300);
  const categoryLabel = CATEGORY_LABEL[card.category] || card.category;
  const canonical = `${SITE}/blog/${slug}/`;
  const ogImage = `${SITE}${heroPath}`;

  const otherPosts = cardOrder.filter((s) => s !== slug);

  const relatedListHtml = otherPosts
    .slice(0, 6)
    .map((s) => `<li><a href="/blog/${s}/">${cards[s].title}</a></li>`)
    .join('\n            ');

  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeAttr(pageTitle)} | The New Mom Journal</title>
<meta name="description" content="${escapeAttr(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="The New Mom Journal">
<meta property="og:title" content="${escapeAttr(pageTitle)}">
<meta property="og:description" content="${escapeAttr(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${ogImage}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeAttr(pageTitle)}">
<meta name="twitter:description" content="${escapeAttr(description)}">
<meta name="twitter:image" content="${ogImage}">
${sharedStyle}
<style>
  .nm-simple-nav { max-width: 720px; margin: 0 auto; padding: 20px 20px 0; }
  .nm-simple-nav a { font-size: 0.9rem; color: var(--accent-deep); text-decoration: none; font-weight: 600; }
  .nm-related-simple { max-width: 720px; margin: 40px auto 0; padding: 0 20px; }
  .nm-related-simple h2 { font-size: 1.2rem; margin-bottom: 12px; }
  .nm-related-simple ul { padding-left: 20px; line-height: 1.9; }
  .nm-related-simple a { color: var(--accent-deep); }
  .nm-simple-footer { max-width: 720px; margin: 50px auto 30px; padding: 0 20px; text-align: center; font-size: 0.85rem; color: var(--ink-soft); }
  .nm-article { max-width: 720px; margin: 24px auto 0; padding: 0 20px; }
</style>
</head>
<body>
<nav class="nm-simple-nav"><a href="/">&larr; The New Mom Journal</a> &middot; <a href="/category-${card.category}.html">${escapeAttr(categoryLabel)}</a></nav>
<article class="nm-article">
${staticArticleHtml}
</article>
<div class="nm-related-simple">
  <h2>More for you</h2>
  <ul>
    ${relatedListHtml}
  </ul>
</div>
<div class="nm-simple-footer"><a href="/">See all posts on The New Mom Journal</a></div>
</body>
</html>
`;

  fs.writeFileSync(path.join(postDir, 'index.html'), page);

  const dateMatch = /([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(card.metaText);
  let lastmod = new Date().toISOString().slice(0, 10);
  if (dateMatch) {
    const d = new Date(dateMatch[1]);
    if (!isNaN(d.getTime())) lastmod = d.toISOString().slice(0, 10);
  }
  sitemapEntries.push({ loc: canonical, lastmod });

  posts.push({ slug, heroPath, cleanedTplInner });
}

// ---------- 7. sitemap.xml + robots.txt ----------
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${SITE}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
${sitemapEntries
  .map((e) => `<url><loc>${e.loc}</loc><lastmod>${e.lastmod}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>`)
  .join('\n')}
</urlset>
`;
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap);

const robots = `User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml
`;
fs.writeFileSync(path.join(ROOT, 'robots.txt'), robots);

// ---------- 8. Patch index.html in place ----------
// 8a. Replace card hero + template inline base64 images with real file paths.
// Anchored per-card (not a literal whole-file string replace): some source
// images are byte-identical to images used elsewhere in the file (e.g. a
// stock photo reused in decorative/dead markup), so a plain raw.replace()
// on the literal data URI can hit the wrong occurrence. Anchoring the
// regex to this card's own <a data-article="slug"> block guarantees we
// only touch that card's own <img>.
for (const slug of cardOrder) {
  const card = cards[slug];
  const heroDec = decodeDataUri(card.imgDataUri);
  const heroFile = `hero.${heroDec.ext}`;
  const heroPath = `/blog/${slug}/${heroFile}`;
  const cardImgRe = new RegExp(
    `(<a class="nm-card" href="#" data-article="${slug}"[^>]*>[\\s\\S]*?<img src=")data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+(")`
  );
  const before = raw;
  raw = raw.replace(cardImgRe, `$1${heroPath}$2`);
  if (raw === before) throw new Error('card image replace failed for slug ' + slug);
}
for (const p of posts) {
  const originalTplRe = new RegExp(
    `(<template id="tpl-${p.slug}">)([\\s\\S]*?)(</template>)`
  );
  raw = raw.replace(originalTplRe, `$1${p.cleanedTplInner}$3`);
}

// 8b. Extract + replace homepage decorative images (hero media + carousel).
raw = raw.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, (m) => {
  const p = extractHomeImage(m);
  return p || m;
});

// 8c. Fix <title>/meta in <head>. Remove the misplaced <title> after <body>.
raw = raw.replace('<title>The New Mom Journal — Design Preview</title>\n', '');

const homeTitle = 'The New Mom Journal — Real Talk on Pregnancy, Breastfeeding & Newborn Care';
const homeDescription =
  'Honest, practical guidance for pregnancy, breastfeeding, and the first year with your newborn — sore nipples, sleep, feeding schedules, and the questions no one prepares you for.';
const headExtra = `<title>${escapeAttr(homeTitle)}</title>
<meta name="description" content="${escapeAttr(homeDescription)}">
<link rel="canonical" href="${SITE}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="The New Mom Journal">
<meta property="og:title" content="${escapeAttr(homeTitle)}">
<meta property="og:description" content="${escapeAttr(homeDescription)}">
<meta property="og:url" content="${SITE}/">
<meta property="og:image" content="${SITE}/assets/home-1.jpg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeAttr(homeTitle)}">
<meta name="twitter:description" content="${escapeAttr(homeDescription)}">
<meta name="twitter:image" content="${SITE}/assets/home-1.jpg">
</head>`;
raw = raw.replace('</head>', headExtra);

// 8d. Real hrefs on cards so crawlers (and no-JS users) can navigate directly.
raw = raw.replace(/<a class="nm-card" href="#" data-article="([^"]+)"/g, '<a class="nm-card" href="/blog/$1/" data-article="$1"');

// 8e. Nice-to-have: keep document.title in sync when the SPA renders an
// article client-side (helps the browser tab / bookmark, share-at-that-
// moment previews; the static pages above are the real fix for crawlers).
raw = raw.replace(
  "function renderArticle(slug, heroSrc) {\n    var tpl = document.getElementById('tpl-' + slug);\n    if (!tpl) return;\n    articleRender.innerHTML = tpl.innerHTML;",
  "function renderArticle(slug, heroSrc) {\n    var tpl = document.getElementById('tpl-' + slug);\n    if (!tpl) return;\n    articleRender.innerHTML = tpl.innerHTML;\n    var titleEl = articleRender.querySelector('.nm-article__title');\n    document.title = (titleEl ? titleEl.textContent : 'The New Mom Journal') + ' | The New Mom Journal';"
);
raw = raw.replace(
  "      if (filter === 'all') {\n        setActiveFilter('all');\n        show('list');",
  "      if (filter === 'all') {\n        setActiveFilter('all');\n        show('list');\n        document.title = 'The New Mom Journal — Real Talk on Pregnancy, Breastfeeding & Newborn Care';"
);

fs.writeFileSync(SRC, raw);

console.log(`Generated ${cardOrder.length} static blog pages, sitemap.xml, robots.txt.`);
console.log(`Extracted ${homeImgCounter} homepage decorative images to /assets.`);
