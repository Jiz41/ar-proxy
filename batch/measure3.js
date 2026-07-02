// 3連単8点構成の最適化測定（コード変更なし・測定のみ）
// 予想top4を A,B,C,D（スコア降順）とし、実着順1-2-3を順列ラベルへ写像。
// 24順列の実現頻度から複数の8点構成を構築し、1331レースで比較する。
// 過学習チェックとして前半/後半スプリット検証も行う。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OUT = '/root/ar-proxy-repo/output';
const sb = { window: {}, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'ar_ronde_live.js'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'ar_adapter_live.js'), 'utf8'), sb);
const W = sb.window;

function loadJsonl(f) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(d => d && !d.error);
}
const rcMap = new Map();
for (const fn of ['racecard_wet.jsonl', 'racecard_good.jsonl'])
  for (const d of loadJsonl(path.join(OUT, fn)))
    rcMap.set([d.venue, d.kaisaiId, d.day, d.raceNo].join('|'), d);

// 配当フィールド有無の確認
const sampleRes = loadJsonl(path.join(OUT, 'results_isesaki_20260315-20260624.jsonl'))[0];
const hasPayout = Object.keys(sampleRes).some(k => /pay|odds|refund|haitou/i.test(k));
console.log('[配当データ] results内の配当/オッズ系フィールド:', hasPayout ? 'あり' : 'なし（回収率は定性評価のみ）');

const std = v => { const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length); };

const races = [];
const seen = new Set();
for (const fp of fs.readdirSync(OUT).filter(f => f.startsWith('results_')).sort()) {
  for (const race of loadJsonl(path.join(OUT, fp))) {
    const key = [race.venue, race.kaisaiId, race.day, race.raceNo].join('|');
    if (seen.has(key)) continue; seen.add(key);
    const card = rcMap.get(key); if (!card) continue;
    const cond = (race.trackCondition || '').includes('湿') ? '湿走路' : '良走路';
    const actual = {};
    for (const r of race.results || []) if ([1, 2, 3].includes(r.order)) actual[r.order] = r.carNum;
    if (!(1 in actual && 2 in actual && 3 in actual)) continue;
    const adapted = W.ArAdapter.parseRaceData({ ...card, condition: cond });
    if (adapted.players.length < 3) continue;
    if (card.day > 1) {
      const d1 = rcMap.get([card.venue, card.kaisaiId, 1, card.raceNo].join('|'));
      if (d1) {
        const t = {}; d1.riders.forEach(r => { if (r.trialTime > 0) t[r.carNum] = r.trialTime; });
        adapted.players.forEach(p => { p.dayProg = (p.trialTime > 0 && t[p.carNum] > 0) ? (p.trialTime - t[p.carNum]) : 0; });
      }
    }
    const scored = W.ArRonde.calcRaceScores(adapted.players, adapted.roadCondition);
    const ranked = [...scored].sort((a, b) => b.totalScore - a.totalScore);
    const top4 = ranked.slice(0, 4).map(p => p.carNum);
    const rankOf = c => { const i = top4.indexOf(c); return i < 0 ? null : i + 1; };
    const a1 = rankOf(actual[1]), a2 = rankOf(actual[2]), a3 = rankOf(actual[3]);
    const perm = (a1 && a2 && a3) ? `${a1}-${a2}-${a3}` : null; // top4外が絡めばnull=不的中
    races.push({ perm, scoreStd: std(scored.map(p => p.totalScore)) });
  }
}
const N = races.length;
console.log('[対象]', N, 'レース（前回基盤と同一）\n');

// 24順列の実現頻度
const freq = {};
races.forEach(r => { if (r.perm) freq[r.perm] = (freq[r.perm] || 0) + 1; });
const allPerms = [];
for (let i = 1; i <= 4; i++) for (let j = 1; j <= 4; j++) for (let k = 1; k <= 4; k++)
  if (i !== j && j !== k && i !== k) allPerms.push(`${i}-${j}-${k}`);
const sorted = allPerms.map(p => [p, freq[p] || 0]).sort((x, y) => y[1] - x[1]);
console.log('[24順列 実現頻度（A=予想1位…D=予想4位）]');
sorted.forEach(([p, n], i) => {
  process.stdout.write(`  ${p}:${(100 * n / N).toFixed(1)}%(${n})${(i + 1) % 4 === 0 ? '\n' : '  '}`);
});
console.log();

// 8点構成候補
const SETS = {
  'S1 頻度top8（データ最適）': sorted.slice(0, 8).map(x => x[0]),
  'S2 A頭6点+B頭2点(B-A-C,B-A-D)': ['1-2-3', '1-3-2', '1-2-4', '1-4-2', '1-3-4', '1-4-3', '2-1-3', '2-1-4'],
  'S3 BOX6+A-B-D,A-D-B': ['1-2-3', '1-3-2', '2-1-3', '2-3-1', '3-1-2', '3-2-1', '1-2-4', '1-4-2'],
  'S4 AB頭フォーメーション(A,B)-(A,B,C)-(全)': ['1-2-3', '1-2-4', '1-3-2', '1-3-4', '2-1-3', '2-1-4', '2-3-1', '2-3-4'],
  'S5 穴目:非A頭 頻度top8': sorted.filter(([p]) => !p.startsWith('1-')).slice(0, 8).map(x => x[0]),
  'S6 穴目:C,D絡みA頭外し': ['2-1-3', '2-1-4', '2-3-1', '3-1-2', '3-2-1', '2-4-1', '3-1-4', '4-1-2'],
  'S7 穴目:2着波乱型(A頭でも2着C/D)': ['1-3-2', '1-3-4', '1-4-2', '1-4-3', '2-3-1', '2-4-1', '3-1-2', '3-2-1'],
};

const hitRate = (set, rs) => {
  const s = new Set(set);
  const h = rs.filter(r => r.perm && s.has(r.perm)).length;
  return [h, rs.length];
};

console.log('[8点構成 比較（全1331レース、参考: BOX6=18.5%・6点）]');
const half1 = races.slice(0, Math.floor(N / 2)), half2 = races.slice(Math.floor(N / 2));
for (const [name, set] of Object.entries(SETS)) {
  const [h, n] = hitRate(set, races);
  const [h1, n1] = hitRate(set, half1);
  const [h2, n2] = hitRate(set, half2);
  console.log(`  ${name}`);
  console.log(`    構成: ${set.join(', ')}`);
  console.log(`    的中率: ${(100 * h / n).toFixed(1)}% (${h}/${n})  [前半${(100 * h1 / n1).toFixed(1)}% / 後半${(100 * h2 / n2).toFixed(1)}%]`);
}

// 頻度top8の過学習チェック: 前半で選び後半で評価
const freqH1 = {};
half1.forEach(r => { if (r.perm) freqH1[r.perm] = (freqH1[r.perm] || 0) + 1; });
const top8H1 = allPerms.map(p => [p, freqH1[p] || 0]).sort((x, y) => y[1] - x[1]).slice(0, 8).map(x => x[0]);
const [ho, no] = hitRate(top8H1, half2);
console.log(`\n[S1過学習チェック] 前半だけで頻度top8を選定 → 後半で評価: ${(100 * ho / no).toFixed(1)}% (${ho}/${no})`);
console.log(`  前半選定セット: ${top8H1.join(', ')}`);
