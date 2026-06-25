'use strict';
/**
 * batch/enrich_vehicle.js
 * 既存 output/*.jsonl に changeVehicle (0/1) を追記する。
 * 使い方: node batch/enrich_vehicle.js
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
  const files = fs.readdirSync(outputDir)
    .filter(f => f.match(/^results_\w+_\d{8}-\d{8}\.jsonl$/));

  let total = 0, enriched = 0, skipped = 0;

  for (const file of files) {
    const filePath = path.join(outputDir, file);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
    console.log(`\n[${file}] ${lines.length} races`);

    const updated = [];
    for (let i = 0; i < lines.length; i++) {
      const record = JSON.parse(lines[i]);
      total++;

      // 既に changeVehicle がある場合はスキップ
      if (record.results && record.results[0]?.changeVehicle !== undefined) {
        skipped++;
        updated.push(JSON.stringify(record));
        continue;
      }

      const { venue, kaisaiId, day, raceNo } = record;
      let fresh;
      try {
        await sleep();
        fresh = await getResultData(venue, kaisaiId, day, raceNo);
      } catch (e) {
        console.log(`  [${i+1}/${lines.length}] R${raceNo} SKIP: ${e.message}`);
        updated.push(JSON.stringify(record));
        continue;
      }

      if (!fresh?.results?.length) {
        updated.push(JSON.stringify(record));
        continue;
      }

      const cvMap = {};
      for (const r of fresh.results) cvMap[String(r.playerId)] = r.changeVehicle ?? 0;

      const merged = record.results.map(r => ({
        ...r,
        changeVehicle: cvMap[String(r.playerId)] ?? 0,
      }));

      const cvCount = merged.filter(r => r.changeVehicle).length;
      if (cvCount > 0) process.stdout.write(`  [${i+1}/${lines.length}] cv=${cvCount} `);

      updated.push(JSON.stringify({ ...record, results: merged }));
      enriched++;
    }

    fs.writeFileSync(filePath, updated.join('\n') + '\n', 'utf8');
  }

  console.log(`\n完了: total=${total} enriched=${enriched} skipped=${skipped}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
