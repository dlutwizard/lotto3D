import fs from 'node:fs/promises';

const SINA_SOURCE = 'https://lotto.sina.cn/trend/lotto_zst_proxy.d.json?lottoType=3d&actionType=chzs&type=50&sourceName=bd&callback=zst';
const OFFICIAL_SOURCE = 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice?name=3d&issueCount=30';
const FILE = 'draws.json';
const FORCE_FINAL = process.env.FORCE_FINAL === '1';

function chinaNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const m = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return {
    date: m.year + '-' + m.month + '-' + m.day,
    hour: Number(m.hour),
    minute: Number(m.minute),
  };
}

function weekdayOf(date) {
  const p = date.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]).getDay() || 7;
}

async function loadDraws() {
  try {
    const existing = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return existing && existing.draws && typeof existing.draws === 'object' ? existing.draws : {};
  } catch (err) {
    return {};
  }
}

function latestIssue(draws) {
  let max = 0;
  Object.values(draws).forEach(rec => {
    const issue = Number(typeof rec === 'string' ? 0 : rec && rec.issue);
    if (Number.isFinite(issue) && issue > max) max = issue;
  });
  return max;
}

function findIssueDate(draws, issue) {
  return Object.keys(draws).find(date => {
    const rec = draws[date];
    return rec && String(rec.issue) === String(issue);
  });
}

function maxIssueRecord(draws) {
  let maxIssue = 0;
  let maxDate = '';
  Object.keys(draws).forEach(date => {
    const rec = draws[date];
    const issue = Number(rec && typeof rec === 'object' ? rec.issue : 0);
    if (Number.isFinite(issue) && issue > maxIssue) {
      maxIssue = issue;
      maxDate = date;
    }
  });
  return { maxIssue, maxDate };
}

function addDays(date, days) {
  const parts = date.split('-').map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 3D 每天开奖，期号连续。用于把延迟运行或跨天补抓的结果对回真实日期。
function deriveIssueDate(draws, issue) {
  const { maxIssue, maxDate } = maxIssueRecord(draws);
  if (!maxIssue || !maxDate) return null;
  const delta = issue - maxIssue;
  if (delta < 1 || delta > 3) return null;
  return addDays(maxDate, delta);
}

function parseSinaHtml(html) {
  let best = null;
  const rows = html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g);
  for (const match of rows) {
    const row = match[1];
    const issueMatch = row.match(/<td[^>]*>(\d{7})<\/td>/);
    if (!issueMatch) continue;
    const fens = [...row.matchAll(/<td class="fen">([^<]+)<\/td>/g)].map(m => m[1].trim());
    const weekday = Number(fens[0]);
    let number = fens.length >= 2 ? fens[1] : '';
    if (!/^\d{3}$/.test(number)) {
      const bg = row.match(/<td class="bg3">(\d{3})<\/td>/);
      number = bg ? bg[1] : '';
    }
    if (!/^\d{3}$/.test(number)) continue;
    if (!(weekday >= 1 && weekday <= 7)) continue;
    const issue = Number(issueMatch[1]);
    if (!best || issue > best.issue) best = { issue, weekday, number };
  }
  return best;
}

async function fetchSinaLatest() {
  const response = await fetch(SINA_SOURCE + '&_=' + Date.now(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      'Referer': 'https://lotto.sina.cn/',
      'Accept': 'application/json,text/plain,*/*',
    },
  });
  if (!response.ok) throw new Error('Sina HTTP ' + response.status);
  const text = await response.text();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Unexpected Sina response');
  const data = JSON.parse(text.slice(start, end + 1));
  const html = data && data.result && data.result.data && data.result.data.data;
  if (typeof html !== 'string') throw new Error('Sina HTML missing');

  return parseSinaHtml(html);
}

async function fetchOfficial() {
  const response = await fetch(OFFICIAL_SOURCE, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; lotto3D-updater/1.0)',
      'Referer': 'https://www.cwl.gov.cn/',
      'Accept': 'application/json,text/plain,*/*',
    },
  });
  if (!response.ok) throw new Error('Official API HTTP ' + response.status);
  const data = await response.json();
  if (data.state !== 0 || !Array.isArray(data.result)) {
    throw new Error('Unexpected official API response');
  }
  return data.result;
}

function mergeOfficialResults(result, draws) {
  let changed = 0;
  for (const item of result) {
    const date = String(item.date || '').slice(0, 10);
    const number = String(item.red || '').split(',').join('');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{3}$/.test(number)) continue;
    const issue = String(item.code || '');
    if (!draws[date] || draws[date].number !== number || draws[date].issue !== issue) {
      draws[date] = { issue, number };
      changed++;
    }
  }
  return changed;
}

async function saveDraws(draws) {
  const sorted = Object.fromEntries(
    Object.entries(draws).sort(([a], [b]) => b.localeCompare(a))
  );
  const payload = {
    updatedAt: new Date().toISOString(),
    source: SINA_SOURCE,
    fallbackSource: OFFICIAL_SOURCE,
    draws: sorted,
  };
  await fs.writeFile(FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return Object.keys(sorted).length;
}

function report(message, isError) {
  const line = (isError ? '::error::' : '::warning::') + message;
  if (isError) console.error(line);
  else console.warn(line);
}

const now = chinaNow();
const minuteOfDay = now.hour * 60 + now.minute;
const finalAttempt = FORCE_FINAL || minuteOfDay >= 21 * 60 + 40;
const draws = await loadDraws();
const todayRecord = draws[now.date];
const todayNumber = typeof todayRecord === 'string' ? todayRecord : todayRecord && todayRecord.number;

if (/^\d{3}$/.test(todayNumber || '')) {
  console.log('Today ' + now.date + ' already has draw ' + todayNumber + '; skip fetching.');
  process.exit(0);
}

let changed = 0;
let sinaError = null;
try {
  const sina = await fetchSinaLatest();
  if (sina) {
    const existingDate = findIssueDate(draws, sina.issue);
    const todayWeekday = weekdayOf(now.date);
    if (existingDate) {
      console.log('Sina latest issue ' + sina.issue + ' already stored for ' + existingDate + '.');
    } else {
      const derivedDate = deriveIssueDate(draws, sina.issue);
      const targetDate = derivedDate || (sina.weekday === todayWeekday ? now.date : null);
      if (targetDate && !draws[targetDate] && targetDate <= now.date) {
        draws[targetDate] = { issue: String(sina.issue), number: sina.number, source: 'sina' };
        changed++;
        console.log('Sina: ' + targetDate + ' issue ' + sina.issue + ' number ' + sina.number);
      } else {
        report('Sina latest issue ' + sina.issue + ' (weekday ' + sina.weekday + ') does not match ' + now.date + ' (weekday ' + todayWeekday + ').');
      }
    }
  }
} catch (err) {
  sinaError = err;
  report('Sina fetch failed: ' + err.message);
}

const stillMissing = !draws[now.date];
if (stillMissing) {
  try {
    const official = await fetchOfficial();
    const officialChanged = mergeOfficialResults(official, draws);
    if (officialChanged > 0) {
      changed += officialChanged;
      console.log('Official fallback changed ' + officialChanged + ' draw days.');
    }
  } catch (err) {
    report('Official fallback failed: ' + err.message);
  }
}

if (changed > 0) {
  const total = await saveDraws(draws);
  console.log('Saved ' + total + ' draw days; changed ' + changed);
} else {
  console.log('No draw changes; draws.json was not rewritten.');
}

const mergedToday = draws[now.date];
const mergedNumber = typeof mergedToday === 'string' ? mergedToday : mergedToday && mergedToday.number;
if (!/^\d{3}$/.test(mergedNumber || '')) {
  report('No 3D draw result for ' + now.date + ' yet.' + (sinaError ? ' Sina error: ' + sinaError.message : ''));
  process.exit(finalAttempt ? 1 : 0);
}

console.log('Today ' + now.date + ' draw ' + mergedNumber + ' is available.');
