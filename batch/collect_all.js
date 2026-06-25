/**
 * batch/collect_all.js
 * 使い方: node batch/collect_all.js
 *
 * 引数不要。川口・伊勢崎・浜松・飯塚・山陽 の5会場について
 * 昨日(JST)から最大30日遡り、各会場88レース分を収集する。
 * localhostサーバー不要。result.js が直接WINTICKETへリクエストする。
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { getResultData } = require('../result');

// --- 定数 ---

const VENUES = [
  { slug: 'kawaguchi', venueId: '02' },
  { slug: 'isesaki',   venueId: '03' },
  { slug: 'hamamatsu', venueId: '04' },
  { slug: 'iizuka',    venueId: '05' },
  { slug: 'sanyo',     venueId: '06' },
];

const MAX_RACE_NO       = 12;
const MAX_DAYS_PER_VENUE = 30;
const TARGET_COUNT      = 88;

// --- ユーティリティ ---

/**
 * 2000〜3000ms のランダムスリープ
 */
function sleep() {
  const ms = 2000 + Math.floor(Math.random() * 1001);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * JST の「昨日」を YYYYMMDD 文字列で返す
 */
function yesterdayJST() {
  // JST = UTC+9
  const now = new Date();
  // UTC時刻に9時間足してJST相当のDateを作る
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  // 1日引く
  jstNow.setUTCDate(jstNow.getUTCDate() - 1);
  const y = jstNow.getUTCFullYear();
  const m = String(jstNow.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jstNow.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * YYYYMMDD 文字列から N 日前の YYYYMMDD 文字列を返す
 */
function subtractDay(yyyymmdd, n = 1) {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1; // 0-indexed
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  const ny = dt.getUTCFullYear();
  const nm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const nd = String(dt.getUTCDate()).padStart(2, '0');
  return `${ny}${nm}${nd}`;
}

/**
 * output/ ディレクトリを確保して返す
 */
function ensureOutputDir() {
  const dir = path.resolve(__dirname, '..', 'output');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 1レース分を JSONL として追記
 */
function appendRecord(filePath, record) {
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

// --- 会場ごとの収集処理 ---

/**
 * @param {string} slug     - venue slug
 * @param {string} venueId  - 2桁 (例: '02')
 * @param {string} outputDir
 * @param {number} venueIndex  - 0-based
 * @param {number} totalVenues
 * @returns {number} 収集したレース数
 */
async function collectVenue(slug, venueId, outputDir, venueIndex, totalVenues) {
  console.log(`\n[${venueIndex + 1}/${totalVenues}] ${slug} 処理開始`);

  let collected  = 0;
  let triedDays  = 0;
  let currentDate = yesterdayJST();

  // kaisaiId 重複処理防止キャッシュ
  const processedKaisaiIds = new Set();

  // 収集データの日付範囲追跡
  let minDate = null;
  let maxDate = null;

  // 出力ファイル（日付範囲はあとで確定するため一時名で開始し最後にリネーム）
  // クラッシュ対策でとにかく書き始め、完了後に最終ファイル名へ移動する
  const tmpFile = path.join(outputDir, `results_${slug}_tmp.jsonl`);

  // 既存の一時ファイルがあれば削除して新規スタート
  if (fs.existsSync(tmpFile)) {
    fs.unlinkSync(tmpFile);
  }

  while (collected < TARGET_COUNT && triedDays < MAX_DAYS_PER_VENUE) {
    const kaisaiId = currentDate + venueId;

    if (!processedKaisaiIds.has(kaisaiId)) {
      processedKaisaiIds.add(kaisaiId);

      // day=1 / raceNo=1 で開催確認プローブ
      let openingResult = null;
      try {
        await sleep();
        openingResult = await getResultData(slug, kaisaiId, 1, 1);
      } catch (_e) {
        // 開催なし or エラー → スキップ
        openingResult = null;
      }

      const hasOpening =
        openingResult !== null &&
        Array.isArray(openingResult.results) &&
        openingResult.results.length > 0;

      if (hasOpening) {
        console.log(`  ${currentDate} kaisaiId=${kaisaiId} 開催確認`);

        // day=1,2,3 × raceNo=1..12 を収集
        for (const day of [1, 2, 3]) {
          let dayHadAnyRace = false;

          for (let raceNo = 1; raceNo <= MAX_RACE_NO; raceNo++) {
            // day=1 raceNo=1 はプローブ済みなので再利用
            let result = null;
            if (day === 1 && raceNo === 1) {
              result = openingResult;
            } else {
              try {
                await sleep();
                result = await getResultData(slug, kaisaiId, day, raceNo);
              } catch (_e) {
                result = null;
              }
            }

            const valid =
              result !== null &&
              Array.isArray(result.results) &&
              result.results.length > 0;

            if (!valid) {
              // このdayはここで終了
              break;
            }

            dayHadAnyRace = true;

            const orderSummary = result.results
              .slice(0, 3)
              .map(r => r.carNum)
              .join('→');

            const remaining = TARGET_COUNT - collected - 1; // -1 は今から書く分
            console.log(
              `    day=${day} R${raceNo} ✓ (order: ${orderSummary}...) 残り: ${remaining}件`
            );

            const record = {
              date:           currentDate,
              venue:          slug,
              kaisaiId,
              day:            result.day,
              raceNo:         result.raceNo,
              trackCondition: result.trackCondition,
              weather:        result.weather,
              temperature:    result.temperature,
              humidity:       result.humidity,
              results:        result.results,
            };
            appendRecord(tmpFile, record);
            collected++;

            // 日付範囲を更新
            if (minDate === null || currentDate < minDate) minDate = currentDate;
            if (maxDate === null || currentDate > maxDate) maxDate = currentDate;

            if (collected >= TARGET_COUNT) break;
          } // raceNo loop

          // day に1件もなければ以降のdayも存在しないとみなす
          if (!dayHadAnyRace && day > 1) break;

          if (collected >= TARGET_COUNT) break;
        } // day loop

      } else {
        // 開催なし：静かにスキップ（verboseにしない）
      }
    }

    // 1日前へ
    currentDate = subtractDay(currentDate, 1);
    triedDays++;
  }

  if (triedDays >= MAX_DAYS_PER_VENUE && collected < TARGET_COUNT) {
    console.warn(
      `  [WARN] ${slug}: 最大遡及日数(${MAX_DAYS_PER_VENUE}日)に達しました。` +
      `収集数: ${collected}件`
    );
  }

  // 一時ファイルを最終ファイル名にリネーム
  if (collected > 0) {
    // minDate/maxDate はどちらも YYYYMMDD
    const finalFile = path.join(
      outputDir,
      `results_${slug}_${minDate}-${maxDate}.jsonl`
    );
    fs.renameSync(tmpFile, finalFile);
    console.log(`  収集完了: ${collected}件 → ${finalFile}`);
  } else {
    // 0件の場合は一時ファイルを削除
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    console.log(`  収集完了: 0件（出力ファイルなし）`);
  }

  return collected;
}

// --- エントリポイント ---

async function main() {
  const outputDir = ensureOutputDir();
  let grandTotal = 0;

  for (let i = 0; i < VENUES.length; i++) {
    const { slug, venueId } = VENUES[i];
    const count = await collectVenue(slug, venueId, outputDir, i, VENUES.length);
    grandTotal += count;
  }

  console.log(`\n5会場合計 ${grandTotal} レース収集完了`);
}

main().catch(e => {
  console.error('予期しないエラー:', e.message);
  process.exit(1);
});
