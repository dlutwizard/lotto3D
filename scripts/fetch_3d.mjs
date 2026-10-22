import fs from 'node:fs/promises';

const SOURCE = 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice?name=3d&issueCount=30';
const FILE = 'draws.json';

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

let existing = { draws: {} };
try {
  existing = JSON.parse(await fs.readFile(FILE, 'utf8'));
} catch (err) {}

const draws = { ...(existing.draws || {}) };
let changed = 0;
for (const item of data.result) {
  const date = String(item.date || '').slice(0, 10);
  const number = String(item.red || '').split(',').join('');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{3}$/.test(number)) continue;
  const issue = String(item.code || '');
  if (!draws[date] || draws[date].number !== number || draws[date].issue !== issue) {
    draws[date] = { issue, number };
    changed++;
  }
}

const sorted = Object.fromEntries(
  Object.entries(draws).sort(([a], [b]) => b.localeCompare(a))
);
const payload = {
  updatedAt: new Date().toISOString(),
  source: SOURCE,
  draws: sorted,
};
await fs.writeFile(FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log('Saved ' + Object.keys(sorted).length + ' draw days; changed ' + changed);
