import fs from 'node:fs/promises';
import path from 'node:path';

const LIST_URL = 'https://www.800820.net/zone/zlist_10.html';
const BASE = 'https://www.800820.net';
const DIR = 'charts';
const INDEX = 'charts.json';
const KEEP = 14;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function getBuf(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': BASE + '/', 'Accept': '*/*' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return new Uint8Array(await res.arrayBuffer());
}

async function getText(url) {
  return new TextDecoder('utf-8').decode(await getBuf(url));
}

function pickLatest(html) {
  let best = null;
  const re = /href="(\/p\/(\d+)\.html)"[^>]*>\s*九宝图\s*(\d{5})\s*期/g;
  for (const m of html.matchAll(re)) {
    const shortIssue = Number(m[3]);
    const issue = '2026' + String(shortIssue).slice(-3);
    if (!best || Number(issue) > Number(best.issue)) best = { issue, url: BASE + m[1] };
  }
  return best;
}

function webpSize(buf) {
  const ascii = (a, b) => Buffer.from(buf.slice(a, b)).toString('ascii');
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WEBP') return null;
  const type = ascii(12, 16);
  if (type === 'VP8X') {
    return {
      w: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
      h: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
    };
  }
  if (type === 'VP8 ') {
    return { w: (buf[26] | (buf[27] << 8)) & 0x3fff, h: (buf[28] | (buf[29] << 8)) & 0x3fff };
  }
  if (type === 'VP8L') {
    const v = buf[21] | (buf[22] << 8) | (buf[23] << 16) | (buf[24] << 24);
    return { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 };
  }
  return null;
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
  const latest = pickLatest(await getText(LIST_URL));
  if (!latest) throw new Error('No 九宝图 article found');
  console.log('Latest article: ' + latest.issue + ' ' + latest.url);

  const existing = charts.find(c => String(c.issue) === latest.issue);
  if (existing && existing.image && String(existing.title || '').includes('蜂巢九宫寻宝图')) {
    console.log('Issue ' + latest.issue + ' already downloaded: ' + existing.image);
    return;
  }

  const page = await getText(latest.url);
  const urls = [...new Set([...page.matchAll(/https:\/\/pic\d\.800820\.net\/tumi\/\d{8}\/[a-f0-9]+\.webp/g)].map(m => m[0]))];
  if (!urls.length) throw new Error('No chart image found');

  let chosen = null;
  const portraits = [];
  for (const url of urls) {
    const buf = await getBuf(url);
    const size = webpSize(buf);
    console.log('candidate ' + url.split('/').pop() + ' ' + (size ? size.w + 'x' + size.h : '?') + ' ' + buf.length + 'B');
    if (size && size.h > size.w * 1.2 && buf.length > 5000) {
      portraits.push({ url, buf, size });
    }
  }
  // 同一期常有多张竖图（含广告版、天机图），优先取文件最大的一张（通常是清晰无遮挡的九宫图）
  portraits.sort((a, b) => b.buf.length - a.buf.length);
  if (portraits.length) chosen = portraits[0];
  if (!chosen) throw new Error('No portrait chart image found');

  const file = latest.issue + '.webp';
  await fs.writeFile(path.join(DIR, file), chosen.buf);

  const entry = {
    issue: latest.issue,
    title: '蜂巢九宫寻宝图 第' + latest.issue + '期',
    image: DIR + '/' + file,
    source: latest.url,
    width: chosen.size.w,
    height: chosen.size.h,
    cropTop: Math.round(chosen.size.h * 0.238),
    cropBottom: Math.round(chosen.size.h * 0.129),
    fetchedAt: new Date().toISOString(),
  };
  const next = [entry, ...charts.filter(c => String(c.issue) !== latest.issue)]
    .sort((a, b) => Number(b.issue) - Number(a.issue));
  const keep = next.slice(0, KEEP);
  const keepFiles = new Set(keep.map(c => c.image));
  for (const old of next.slice(KEEP)) {
    if (old.image && !keepFiles.has(old.image)) {
      try { await fs.unlink(old.image); } catch (e) {}
    }
  }
  await fs.writeFile(INDEX, JSON.stringify({ updatedAt: new Date().toISOString(), charts: keep }, null, 2) + '\n', 'utf8');
  console.log('Saved ' + entry.image + ' (' + chosen.buf.length + ' bytes, ' + keep.length + ' kept)');
}

main().catch(err => {
  console.error('chart fetch failed: ' + err.message);
  process.exit(1);
});
