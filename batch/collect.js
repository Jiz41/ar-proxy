/**
 * batch/collect.js
 * 使い方: node batch/collect.js [venue] [dateFrom] [dateTo]
 * 例:     node batch/collect.js kawaguchi 20260601 20260620
 *
 * ar-proxy が localhost:3000 で起動済みであることを前提とする。
 */

const fs   = require('fs');
const path = require('path');

const BASE_URL    = 'http://localhost:3000';
const MAX_RACE_NO = 12;
const SLEEP_MS    = 500;

// --- ユーティリティ ---

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * YYYYMMDD 形式の日付文字列を1日ずつ進めたリストを返す
 */
function dateRange(from, to) {
  const dates = [];
  let cur = new Date(`${from.slice(0,4)}-${from.slice(4,6)}-${from.slice(6,8)}`);
  const end = new Date(`${to.slice(0,4)}-${to.slice(4,6)}-${to.slice(6,8)}`);
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    dates.push(`${y}${m}${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

/**
 * fetch のラッパー（node-fetch を動的 require）
 */
let _fetch;
function getFetch() {
  if (!_fetch) _fetch = require('node-fetch');
  return _fetch;
}

async function getJson(url) {
  const fetch = getFetch();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// --- メイン ---

async function main() {
  const [,, venue, dateFrom, dateTo] = process.argv;

  if (!venue || !dateFrom || !dateTo) {
    console.error('Usage: node batch/collect.js [venue] [dateFrom] [dateTo]');
    console.error('Example: node batch/collect.js kawaguchi 20260601 20260620');
    process.exit(1);
  }

  // output/ ディレクトリを確保
  const outputDir = path.resolve(__dirname, '..', 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  const outFile = path.join(outputDir, `results_${venue}_${dateFrom}-${dateTo}.jsonl`);
  console.log(`出力先: ${outFile}`);

  const dates = dateRange(dateFrom, dateTo);
  console.log(`対象日数: ${dates.length} 日`);

  let totalWritten = 0;

  for (const date of dates) {
    // /kaisai で開催情報を取得
    let kaisaiList;
    try {
      const kaisaiUrl = `${BASE_URL}/kaisai?date=${date}`;
      kaisaiList = await getJson(kaisaiUrl);
      await sleep(SLEEP_MS);
    } catch (e) {
      console.warn(`[SKIP] ${date} /kaisai 取得失敗: ${e.message}`);
      continue;
    }

    // /kaisai は { date, venues: [...] } を返す
    const venues = kaisaiList.venues;
    if (!Array.isArray(venues)) {
      console.warn(`[SKIP] ${date} venues が配列でない`);
      continue;
    }

    // 対象 venue の開催を絞り込む
    const targets = venues.filter(k => k.venue === venue || k.venueSlug === venue);
    if (targets.length === 0) {
      console.log(`[INFO] ${date} ${venue} の開催なし`);
      continue;
    }

    for (const target of targets) {
      const kaisaiId = target.kaisaiId || target.id;
      const day      = target.day || 1;

      if (!kaisaiId) {
        console.warn(`[SKIP] ${date} kaisaiId が取得できない`);
        continue;
      }

      console.log(`[処理] ${date} ${venue} kaisaiId=${kaisaiId} day=${day}`);

      for (let raceNo = 1; raceNo <= MAX_RACE_NO; raceNo++) {
        try {
          const resultUrl = `${BASE_URL}/result?venue=${venue}&kaisaiId=${kaisaiId}&day=${day}&raceNo=${raceNo}`;
          const result = await getJson(resultUrl);

          if (result.error) {
            console.warn(`[SKIP] ${date} R${raceNo} エラー応答: ${result.error}`);
          } else {
            const line = JSON.stringify({
              date,
              venue,
              kaisaiId,
              day:            result.day,
              raceNo:         result.raceNo,
              trackCondition: result.trackCondition,
              weather:        result.weather,
              temperature:    result.temperature,
              humidity:       result.humidity,
              results:        result.results,
            });
            fs.appendFileSync(outFile, line + '\n', 'utf8');
            totalWritten++;
            console.log(`  R${raceNo} 書き込み完了 (着順数: ${result.results ? result.results.length : 0})`);
          }
        } catch (e) {
          console.warn(`[SKIP] ${date} R${raceNo} 取得失敗: ${e.message}`);
        }

        await sleep(SLEEP_MS);
      }
    }
  }

  console.log(`\n完了。合計 ${totalWritten} レース分を書き込みました → ${outFile}`);
}

main().catch(e => {
  console.error('予期しないエラー:', e.message);
  process.exit(1);
});
