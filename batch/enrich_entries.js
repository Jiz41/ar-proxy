'use strict';
/**
 * batch/enrich_entries.js
 * 既存の output/*.jsonl に sunnyOrder / rainyOrder を追記する。
 * result.js 経由で raceresult ページを再フェッチし、entries から取得する。
 * 使い方: node batch/enrich_entries.js
 */

const fs   = require('fs');
const path = require('path');
const { getResultData } = require('../result');

function sleep() {
  const ms = 2000 + Math.floor(Math.random() * 1001);
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const outputDir = path.resolve(__dirname, '..', 'output');
  const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.jsonl') && !f.startsWith('results_enriched'));

  let totalRaces = 0;
  let enriched   = 0;
  let alreadyDone = 0;

  for (const file of files) {
    const filePath = path.join(outputDir, file);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
    console.log(`\n[${file}] ${lines.length} レース処理開始`);

    const updatedLines = [];

    for (let i = 0; i < lines.length; i++) {
      const record = JSON.parse(lines[i]);
      totalRaces++;

      // 既に全エントリが sunnyOrder/rainyOrder を持っている場合はスキップ
      const hasData = record.results && record.results.every(r => r.sunnyOrder !== undefined);
      if (hasData) {
        alreadyDone++;
        updatedLines.push(JSON.stringify(record));
        continue;
      }

      const { venue, kaisaiId, day, raceNo } = record;
      process.stdout.write(`  [${i+1}/${lines.length}] kaisaiId=${kaisaiId} day=${day} R${raceNo} ... `);

      let fresh;
      try {
        await sleep();
        fresh = await getResultData(venue, kaisaiId, day, raceNo);
      } catch (e) {
        console.log(`SKIP (${e.message})`);
        updatedLines.push(JSON.stringify(record));
        continue;
      }

      if (!fresh || fresh.error || !Array.isArray(fresh.results)) {
        console.log('SKIP (no results)');
        updatedLines.push(JSON.stringify(record));
        continue;
      }

      // sunnyOrder / rainyOrder を既存 results にマージ（playerId で突合）
      const freshMap = {};
      for (const r of fresh.results) {
        freshMap[String(r.playerId)] = { sunnyOrder: r.sunnyOrder ?? 0, rainyOrder: r.rainyOrder ?? 0 };
      }

      const merged = record.results.map(r => {
        const pid = String(r.playerId);
        const extra = freshMap[pid] || { sunnyOrder: 0, rainyOrder: 0 };
        return { ...r, sunnyOrder: extra.sunnyOrder, rainyOrder: extra.rainyOrder };
      });

      const sunnyVals = merged.filter(r => r.sunnyOrder > 0).map(r => `${r.carNum}:${r.sunnyOrder}→${r.rainyOrder}`);
      console.log(`OK (${sunnyVals.join(', ') || 'all 0'})`);

      updatedLines.push(JSON.stringify({ ...record, results: merged }));
      enriched++;
    }

    // 同名ファイルに上書き
    fs.writeFileSync(filePath, updatedLines.join('\n') + '\n', 'utf8');
    console.log(`  → ${file} 保存完了`);
  }

  console.log(`\n処理完了: ${totalRaces} レース / enriched=${enriched} / already=${alreadyDone}`);
}

main().catch(e => {
  console.error('エラー:', e.message);
  process.exit(1);
});
