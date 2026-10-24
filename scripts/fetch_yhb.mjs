import fs from 'node:fs/promises';

const LIST_URL = 'https://www.800820.net/zone/zlist_42.html';
const BASE = 'https://www.800820.net';
const INDEX = 'references.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function getText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': BASE + '/', 'Accept-Language': 'zh-CN,zh;q=0.9' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return new TextDecoder('utf-8').decode(new Uint8Array(await res.arrayBuffer()));
}

function decodeHtml(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function pickLatest(html) {
  const re = /href="(\/p\/\d+\.html)"[^>]*>\s*(\d{5})期3D于海滨点评/g;
  let best = null;
  for (const m of html.matchAll(re)) {
    const shortIssue = Number(m[2]);
    const issue = '20' + String(shortIssue);
    if (!best || Number(issue) > Number(best.issue)) best = { issue, url: BASE + m[1] };
  }
  return best;
}

function parseRecommendation(mainHtml) {
  const text = decodeHtml(
    mainHtml
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/p>|<p[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  );
  const lines = text.split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const fields = [];
  const notes = [];

  for (const line of lines) {
    let m = line.match(/^胆码\s+(.+)$/);
    if (m) { fields.push({ label: '胆码', value: m[1].trim() }); continue; }
    m = line.match(/^搭配\s+(.+)$/);
    if (m) { fields.push({ label: '搭配', value: m[1].trim() }); continue; }
    m = line.match(/^两码防\s+(.+)$/);
    if (m) { fields.push({ label: '两码防', value: m[1].trim() }); continue; }
    m = line.match(/^和值\s*(.*?)\s*跨度\s*(.*?)\s*组三\s*(.+)$/);
    if (m) {
      fields.push({ label: '和值', value: m[1].trim() });
      fields.push({ label: '跨度', value: m[2].trim() });
      fields.push({ label: '组三', value: m[3].trim() });
      continue;
    }
    m = line.match(/^专家一语定胆\s+(.+)$/);
    if (m) { notes.push({ label: '专家一语定胆', text: m[1].trim().replace(/\s*解\s*(\d+)$/, ' · 解$1') }); continue; }
    m = line.match(/^3D\s*《天天彩》每日号码精选(.*)$/);
    if (m) {
      const value = m[1].trim().replace(/^胆\s*/, '胆 ').replace(/\s*精选看好\s*/, ' · 精选看好 ');
      notes.push({ label: '天天彩精选', text: value });
    }
  }
  return { fields, notes };
}

async function loadIndex() {
  try {
    return JSON.parse(await fs.readFile(INDEX, 'utf8'));
  } catch (e) {
    return { updatedAt: null, items: [] };
  }
}

async function main() {
  const latest = pickLatest(await getText(LIST_URL));
  if (!latest) throw new Error('No 于海滨 article found');
  console.log('Latest 于海滨 article: ' + latest.issue + ' ' + latest.url);

  const page = await getText(latest.url);
  const main = page.match(/<div class="main-part">([\s\S]*?)<\/div>/);
  if (!main) throw new Error('Recommendation block not found');
  const { fields, notes } = parseRecommendation(main[1]);
  if (!fields.length) throw new Error('Recommendation fields not found');

  const published = page.match(/更新时间:\s*<datetime>([^<]+)<\/datetime>/);
  const image = main[1].match(/<img[^>]+src="([^"]+)"/);
  const item = {
    id: 'yuhaiobin',
    name: '于海滨',
    issue: latest.issue,
    publishedAt: published ? published[1].trim() : '',
    source: latest.url,
    fields,
    notes,
    image: image ? image[1] : '',
    fetchedAt: new Date().toISOString(),
  };

  const data = await loadIndex();
  const items = Array.isArray(data.items) ? data.items : [];
  const next = [item, ...items.filter(x => x.id !== item.id)];
  await fs.writeFile(INDEX, JSON.stringify({ updatedAt: new Date().toISOString(), items: next }, null, 2) + '\n', 'utf8');
  console.log('Saved 于海滨 ' + item.issue + ' (' + fields.length + ' fields, ' + notes.length + ' notes)');
}

main().catch(err => {
  console.error('于海滨 fetch failed: ' + err.message);
  process.exit(1);
});
