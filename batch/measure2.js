// 補完測定（コード変更なし・入力操作のみ）
// (A) lFlag補正版：auditPointをレース内順位化してcalcLPointに渡した場合の層別
// (B) 試走前シミュレーション：全trialTime欠測化 vs avgTrial代替 のBOX6比較
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OUT = '/root/ar-proxy-repo/output';
function load() {
  const sb = { window: {}, console };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'ar_ronde_live.js'), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'ar_adapter_live.js'), 'utf8'), sb);
  return sb.window;
}
const W = load();

function loadJsonl(f) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(d => d && !d.error);
}
const rcMap = new Map();
for (const fname of ['racecard_wet.jsonl', 'racecard_good.jsonl'])
  for (const d of loadJsonl(path.join(OUT, fname)))
    rcMap.set([d.venue, d.kaisaiId, d.day, d.raceNo].join('|'), d);

const setEq = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '% (' + n + '/' + d + ')' : 'n/a';

// 3モード: normal / noTrial(全欠測) / avgSub(欠測をavgTrialで代替)
function predict(card, conditionStr, mode) {
  const apiJson = { ...card, condition: conditionStr };
  const adapted = W.ArAdapter.parseRaceData(apiJson);
  if (adapted.players.length < 3) return null;
  let players = adapted.players;
  if (mode === 'noTrial') {
    players = players.map(p => ({ ...p, trialTime: null, trialDev: 1.0 }));
  } else if (mode === 'avgSub') {
    players = players.map(p => ({ ...p, trialTime: (p.avgTrial > 0 ? p.avgTrial : null), trialDev: 1.0 }));
  }
  const scored = W.ArRonde.calcRaceScores(players, adapted.roadCondition);
  return { adapted, scored, ranked: [...scored].sort((a, b) => b.totalScore - a.totalScore) };
}

const stats = { normal: [0, 0], noTrial: [0, 0], avgSub: [0, 0] };
const lfCorr = { flagged: [0, 0], clean: [0, 0] };
const seen = new Set();

for (const fpath of fs.readdirSync(OUT).filter(f => f.startsWith('results_')).sort()) {
  for (const race of loadJsonl(path.join(OUT, fpath))) {
    const key = [race.venue, race.kaisaiId, race.day, race.raceNo].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const card = rcMap.get(key);
    if (!card) continue;
    const conditionStr = (race.trackCondition || '').includes('湿') ? '湿走路' : '良走路';
    const actual = {};
    for (const res of race.results || []) if ([1, 2, 3].includes(res.order)) actual[res.order] = res.carNum;
    if (!(1 in actual && 2 in actual && 3 in actual)) continue;
    const actualTop3 = [actual[1], actual[2], actual[3]];

    for (const mode of ['normal', 'noTrial', 'avgSub']) {
      const r = predict(card, conditionStr, mode);
      if (!r) continue;
      stats[mode][1]++;
      if (setEq(r.ranked.slice(0, 3).map(p => p.carNum), actualTop3)) stats[mode][0]++;
    }

    // lFlag補正: auditPointをレース内順位（大きいほど1位）に変換してcalcLPointへ
    const r = predict(card, conditionStr, 'normal');
    if (!r) continue;
    const byAudit = [...r.scored].sort((a, b) => b.auditRank - a.auditRank); // auditRank=auditPoint実数
    const rankMap = new Map();
    byAudit.forEach((p, i) => rankMap.set(p.carNum, i + 1));
    const fixed = r.scored.map(p => ({ ...p, auditRank: rankMap.get(p.carNum) }));
    const lp = W.ArRonde.calcLPoint(fixed);
    const bucket = lp.some(p => p.lFlag != null) ? lfCorr.flagged : lfCorr.clean;
    bucket[1]++;
    if (setEq(r.ranked.slice(0, 3).map(p => p.carNum), actualTop3)) bucket[0]++;
  }
}

console.log('[B 試走情報量シミュレーション（同一1331レース・エンジン不変・入力のみ操作）]');
console.log('  通常（実trialTime）:      ' + pct(stats.normal[0], stats.normal[1]));
console.log('  全員試走欠測化（試走前相当）: ' + pct(stats.noTrial[0], stats.noTrial[1]));
console.log('  欠測をavgTrialで代替:      ' + pct(stats.avgSub[0], stats.avgSub[1]));
console.log();
console.log('[A lFlag補正版（auditPointレース内順位化後のcalcLPoint）]');
console.log('  lFlag該当レース: BOX6 ' + pct(lfCorr.flagged[0], lfCorr.flagged[1]));
console.log('  lFlag非該当:     BOX6 ' + pct(lfCorr.clean[0], lfCorr.clean[1]));
