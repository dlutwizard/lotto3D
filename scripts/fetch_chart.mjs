import fs from 'node:fs/promises';
import path from 'node:path';

const LIST_URL = 'https://bbss.17500.cn/list/43.html';
const BASE = 'https://bbss.17500.cn';
const DIR = 'charts';
const INDEX = 'charts.json';
const KEEP = 14;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function getText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': BASE + '/list/43.html', 'Accept': 'text/html,*/*' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  const buf = new Uint8Array(await res.arrayBuffer());
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!/[\u4e00-\u9fa5]/.test(text) || (text.match(/\uFFFD/g) || []).length > 20) {
    try { text = new TextDecoder('gbk').decode(buf); } catch (e) {}
  }
  return text;
}

function pickLatest(html) {
  let best = null;
  const re = /<a[^>]+href="([^"]*article\/\d{4}\/\d{2}\/\d{2}\/\d+-1\.html)"[^>]*title="([^"]*寻宝图[^"]*)"/g;
  for (const m of html.matchAll(re)) {
    const title = m[2].trim();
    const issue = (title.match(/(\d{7})\s*期/) || [])[1];
    if (!issue) continue;
    if (!best || Number(issue) > Number(best.issue)) best = { issue, title, url: m[1] };
  }
  return best;
}

function absolute(href) {
  if (/^https?:/i.test(href)) return href;
  return BASE + (href.startsWith('/') ? href : '/' + href.replace(/^(\.\.\/)+/, ''));
}

function extractImage(html) {
  const m = html.match(/<img[^>]+src=['"]([^'"]*data\/attachment[^'"]+)['"]/i);
  if (m) return m[1];
  const any = html.match(/<img[^>]+src=['"]([^'"]*attachment[^'"]+\.(?:png|jpe?g|gif))['"]/i);
  return any ? any[1] : null;
}

async function loadIndex() {
  try {
    const data = JSON.parse(await fs.readFile(INDEX, 'utf8'));
    return Array.isArray(data.charts) ? data.charts : [];
  } catch (e) {
    return [];
  }
}

async function main() {
  await fs.mkdir(DIR, { recursive: true });
  const charts = await loadIndex();
  const listHtml = await getText(LIST_URL);
  const latest = pickLatest(listHtml);
  if (!latest) throw new Error('No 寻宝图 article found');
  console.log('Latest article: ' + latest.issue + ' ' + latest.title);

  const existing = charts.find(c => String(c.issue) === String(latest.issue));
  if (existing && existing.image) {
    console.log('Issue ' + latest.issue + ' already downloaded: ' + existing.image);
    return;
  }

  const page = await getText(absolute(latest.url));
  const img = extractImage(page);
  if (!img) throw new Error('No image found in article');
  const imgUrl = absolute(img);
  const ext = (imgUrl.match(/\.(png|jpe?g|gif)(?:\?|$)/i) || [])[1] || 'png';
  const res = await fetch(imgUrl, { headers: { 'User-Agent': UA, 'Referer': absolute(latest.url) } });
  if (!res.ok) throw new Error('Image HTTP ' + res.status);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 2000) throw new Error('Image too small: ' + buf.length);

  const file = latest.issue + '.' + ext.toLowerCase().replace('jpeg', 'jpg');
  await fs.writeFile(path.join(DIR, file), buf);

  const entry = {
    issue: latest.issue,
    title: latest.title,
    image: DIR + '/' + file,
    source: absolute(latest.url),
    fetchedAt: new Date().toISOString(),
  };
  const next = [entry, ...charts.filter(c => String(c.issue) !== String(latest.issue))]
    .sort((a, b) => Number(b.issue) - Number(a.issue));

  const keep = next.slice(0, KEEP);
  const keepFiles = new Set(keep.map(c => c.image));
  for (const old of next.slice(KEEP)) {
    if (old.image && !keepFiles.has(old.image)) {
      try { await fs.unlink(old.image); } catch (e) {}
    }
  }

  await fs.writeFile(INDEX, JSON.stringify({ updatedAt: new Date().toISOString(), charts: keep }, null, 2) + '\n', 'utf8');
  console.log('Saved ' + entry.image + ' (' + buf.length + ' bytes, ' + keep.length + ' kept)');
}

main().catch(err => {
  console.error('chart fetch failed: ' + err.message);
  process.exit(1);
});
