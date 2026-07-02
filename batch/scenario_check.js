// 脚質分類 vs 実着順の整合測定（generateScenario検証用・再利用可能）
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ENGINE = process.argv[2] || 'ar_ronde_live.js';
const OUT = '/root/ar-proxy-repo/output';
const sb = { window: {}, console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, ENGINE), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'ar_adapter_live.js'), 'utf8'), sb);
const W = sb.window;

const jl = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim())
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(d => d && !d.error) : [];
const rc = new Map();
for (const fn of ['racecard_wet.jsonl', 'racecard_good.jsonl'])
  for (const d of jl(path.join(OUT, fn))) rc.set([d.venue, d.kaisaiId, d.day, d.raceNo].join('|'), d);

const stat = {};
let races = 0;
const seen = new Set();
for (const fp of fs.readdirSync(OUT).filter(f => f.startsWith('results_')).sort()) {
  for (const race of jl(path.join(OUT, fp))) {
    const key = [race.venue, race.kaisaiId, race.day, race.raceNo].join('|');
    if (seen.has(key)) continue; seen.add(key);
    const card = rc.get(key); if (!card) continue;
    const cond = (race.trackCondition || '').includes('湿') ? '湿走路' : '良走路';
    const orderMap = {}; let okOrders = 0;
    for (const r of race.results || []) { if (r.order > 0) { orderMap[r.carNum] = r.order; okOrders++; } }
    if (okOrders < 3) continue;
    const ad = W.ArAdapter.parseRaceData({ ...card, condition: cond });
    if (ad.players.length < 3) continue;
    const sc = W.ArRonde.calcRaceScores(ad.players, ad.roadCondition);
    const scen = W.ArRonde.generateScenario(sc);
    races++;
    for (const p of sc) {
      const t = scen.playerTypes[p.carNum]; if (!t) continue;
      const ao = orderMap[p.carNum]; if (!ao) continue;
      const actualDelta = t.startRank - ao;
      const s = stat[t.label] || (stat[t.label] = { n: 0, big: 0, fadeBig: 0, gainBig: 0, sumAbsErr: 0 });
      s.n++;
      if (Math.abs(actualDelta) >= 2) s.big++;
      if (actualDelta <= -2) s.fadeBig++;
      if (actualDelta >= 2) s.gainBig++;
      s.sumAbsErr += Math.abs(t.finishRank - ao);
    }
  }
}
console.log(`=== ${ENGINE} / ${races}レース ===`);
console.log('タイプ | 選手数(割合) | 実|動き|≥2 | 実後退≥2 | 実追上≥2 | 予測誤差');
let total = 0; Object.values(stat).forEach(s => total += s.n);
for (const [label, s] of Object.entries(stat)) {
  console.log(`${label} | ${s.n}(${(100 * s.n / total).toFixed(1)}%) | ${(100 * s.big / s.n).toFixed(1)}% | ${(100 * s.fadeBig / s.n).toFixed(1)}% | ${(100 * s.gainBig / s.n).toFixed(1)}% | ${(s.sumAbsErr / s.n).toFixed(2)}`);
}
