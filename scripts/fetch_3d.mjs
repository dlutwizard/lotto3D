import fs from 'node:fs/promises';

const SOURCE = 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice?name=3d&issueCount=30';
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

async function loadDraws() {
  try {
    const existing = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return existing && existing.draws && typeof existing.draws === 'object' ? existing.draws : {};
  } catch (err) {
    return {};
  }
}

async function fetchOfficial() {
  const response = await fetch(SOURCE, {
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

function mergeResults(result, draws) {
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
    source: SOURCE,
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

let result;
try {
  result = await fetchOfficial();
} catch (err) {
  report('Failed to fetch 3D results: ' + err.message);
  process.exit(finalAttempt ? 1 : 0);
}

const changed = mergeResults(result, draws);
if (changed > 0) {
  const total = await saveDraws(draws);
  console.log('Saved ' + total + ' draw days; changed ' + changed);
} else {
  console.log('No draw changes; draws.json was not rewritten.');
}

const mergedToday = draws[now.date];
const mergedNumber = typeof mergedToday === 'string' ? mergedToday : mergedToday && mergedToday.number;
if (!/^\d{3}$/.test(mergedNumber || '')) {
  report('No 3D draw result for ' + now.date + ' yet.');
  process.exit(finalAttempt ? 1 : 0);
}

console.log('Today ' + now.date + ' draw ' + mergedNumber + ' is available.');
