// 測定ハーネス：本番 ar_ronde.js + ar_adapter.js を実機どおりに駆動し、
// racecard（予想入力）× results（実着順）を突合して4測定を行う。
// モデル・重みには一切触れない（読み取りのみ）。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ENGINE = process.argv[2] || 'ar_ronde_live.js';
const OUT = '/root/ar-proxy-repo/output';

function load(engineFile) {
  const sb = { window: {}, console };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, engineFile), 'utf8'), sb, { filename: engineFile });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'ar_adapter_live.js'), 'utf8'), sb, { filename: 'ar_adapter.js' });
  return sb.window;
}
const W = load(ENGINE);

function loadJsonl(f) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(d => d && !d.error);
}

// racecard map: venue|kaisaiId|day|raceNo -> race object
const rcMap = new Map();
for (const fname of ['racecard_wet.jsonl', 'racecard_good.jsonl']) {
  for (const d of loadJsonl(path.join(OUT, fname))) {
    rcMap.set([d.venue, d.kaisaiId, d.day, d.raceNo].join('|'), d);
  }
}

const std = vals => {
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / vals.length);
};
const setEq = (a, b) => a.length === b.length && a.every(x => b.includes(x));

const rows = [];
let skipped = { noCard: 0, fewRiders: 0, noTop3: 0, dup: 0 };
const seen = new Set();

for (const fpath of fs.readdirSync(OUT).filter(f => f.startsWith('results_')).sort()) {
  for (const race of loadJsonl(path.join(OUT, fpath))) {
    const key = [race.venue, race.kaisaiId, race.day, race.raceNo].join('|');
    if (seen.has(key)) { skipped.dup++; continue; }
    seen.add(key);
    const card = rcMap.get(key);
    if (!card) { skipped.noCard++; continue; }
    const tc = race.trackCondition || '';
    const conditionStr = tc.includes('湿') ? '湿走路' : '良走路';

    // 実着順 top3
    const actual = {};
    for (const res of race.results || []) {
      if ([1, 2, 3].includes(res.order)) actual[res.order] = res.carNum;
    }
    if (!(1 in actual && 2 in actual && 3 in actual)) { skipped.noTop3++; continue; }

    // 本番経路そのまま：adapter → dayProg付与(ar_main再現) → calcRaceScores
    const apiJson = { ...card, condition: conditionStr };
    const adapted = W.ArAdapter.parseRaceData(apiJson);
    if (adapted.players.length < 3) { skipped.fewRiders++; continue; }

    // day>1 は day1 racecard の同 carNum 試走を dayProg に（ar_main.js の再現）
    if (card.day > 1) {
      const d1 = rcMap.get([card.venue, card.kaisaiId, 1, card.raceNo].join('|'));
      if (d1) {
        const d1t = {};
        d1.riders.forEach(r => { if (r.trialTime > 0) d1t[r.carNum] = r.trialTime; });
        adapted.players.forEach(p => {
          p.dayProg = (p.trialTime > 0 && d1t[p.carNum] > 0) ? (p.trialTime - d1t[p.carNum]) : 0;
        });
      }
    }

    const scored = W.ArRonde.calcRaceScores(adapted.players, adapted.roadCondition);
    const ranked = [...scored].sort((a, b) => b.totalScore - a.totalScore);
    const predTop3 = ranked.slice(0, 3).map(p => p.carNum);
    const predTop4 = ranked.slice(0, 4).map(p => p.carNum);
    const actualTop3 = [actual[1], actual[2], actual[3]];
    const actualStr = actualTop3.join('-');

    // lFlag（calcLPoint、本番実装）
    const lp = W.ArRonde.calcLPoint(scored);
    const hasLFlag = lp.some(p => p.lFlag != null);

    // 試走充足
    const nTrial = adapted.players.filter(p => p.trialTime > 0).length;
    const trialGroup = nTrial === adapted.players.length ? 'full' : (nTrial === 0 ? 'none' : 'partial');

    // 順列判定
    const [A, B, C] = predTop3;
    const perms = {
      '1-2-3': `${A}-${B}-${C}`, '1-3-2': `${A}-${C}-${B}`,
      '2-1-3': `${B}-${A}-${C}`, '2-3-1': `${B}-${C}-${A}`,
      '3-1-2': `${C}-${A}-${B}`, '3-2-1': `${C}-${B}-${A}`,
    };
    let permHit = null;
    for (const [label, s] of Object.entries(perms)) if (s === actualStr) permHit = label;

    rows.push({
      key, venue: race.venue, road: adapted.roadCondition,
      scoreStd: std(scored.map(p => p.totalScore)),
      box6: setEq(predTop3, actualTop3),
      top4cover: actualTop3.every(c => predTop4.includes(c)),
      hasLFlag, trialGroup, permHit,
      volLabel: W.ArRonde.calcVolatility(scored).label,
    });
  }
}

const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '% (' + n + '/' + d + ')' : 'n/a';
const hit = rs => rs.filter(r => r.box6).length;

console.log(`=== エンジン: ${ENGINE} ===`);
console.log(`対象レース: ${rows.length}件（除外 noCard:${skipped.noCard} top3欠け:${skipped.noTop3} 少数:${skipped.fewRiders} 重複:${skipped.dup}）`);
console.log(`走路内訳: 良${rows.filter(r => r.road !== 'wet').length} / 湿${rows.filter(r => r.road === 'wet').length}`);
console.log(`\n[全体] BOX6: ${pct(hit(rows), rows.length)}  top4カバー: ${pct(rows.filter(r => r.top4cover).length, rows.length)}`);

// ① scoreStd三分位
const sorted = [...rows].sort((a, b) => a.scoreStd - b.scoreStd);
const t = Math.floor(rows.length / 3);
const tiers = [sorted.slice(0, t), sorted.slice(t, 2 * t), sorted.slice(2 * t)];
console.log('\n[① scoreStd三分位別 BOX6]');
tiers.forEach((g, i) => {
  const lo = g[0].scoreStd.toFixed(3), hi = g[g.length - 1].scoreStd.toFixed(3);
  console.log(`  T${i + 1} (std ${lo}〜${hi}): ${pct(hit(g), g.length)}  top4カバー: ${pct(g.filter(r => r.top4cover).length, g.length)}`);
});
console.log('  [参考] 現行volatilityラベル別:');
['高', '中', '低'].forEach(l => {
  const g = rows.filter(r => r.volLabel === l);
  console.log(`    ${l}: BOX6 ${pct(hit(g), g.length)}`);
});

// ② top4カバー天井 + lFlag
console.log('\n[② 4頭目カバー天井]');
console.log(`  P(実top3 ⊆ 予想top4): ${pct(rows.filter(r => r.top4cover).length, rows.length)}`);
console.log(`  （BOX6=${pct(hit(rows), rows.length)} との差が構造転換の理論上限）`);
const lf = rows.filter(r => r.hasLFlag), nlf = rows.filter(r => !r.hasLFlag);
console.log(`  lFlag該当レース: BOX6 ${pct(hit(lf), lf.length)} / 非該当: ${pct(hit(nlf), nlf.length)}`);

// ③ 試走あり/なし
console.log('\n[③ 試走充足別 BOX6]');
for (const [g, label] of [['full', '全員試走あり'], ['partial', '一部欠測'], ['none', '全員欠測']]) {
  const rs = rows.filter(r => r.trialGroup === g);
  console.log(`  ${label}: ${pct(hit(rs), rs.length)}`);
}

// 3-c 順列実現率
console.log('\n[3-c 予想top3の6順列 実現率（全レース分母）]');
for (const label of ['1-2-3', '1-3-2', '2-1-3', '2-3-1', '3-1-2', '3-2-1']) {
  const n = rows.filter(r => r.permHit === label).length;
  console.log(`  ${label}: ${pct(n, rows.length)}${label === '1-3-2' ? '  ← 現行絞り1点' : ''}`);
}
