'use strict';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// shadow/crawl.js
// ─────────────────────────────────────────────────────────────────
// RONDE シャドー記録の自動巡回。
//   1. vm_loader で HF の本番ロジックをサンドボックスへロード
//   2. ar-proxy /kaisai で当日開催を取得（Renderコールドスタート対策のリトライ付き）
//   3. 各開催×各レースを /race で巡回し、試走タイムが全員分揃ったレースのみ
//      ブラウザと同一パイプラインで予想を組み立て ArShadow.record(ctx) で GAS へ送信
//   4. 二重送信は shadow/state/sent_YYYYMMDD.json で防止
//
// 使い方:
//   node shadow/crawl.js            … 本番（record 送信あり）
//   node shadow/crawl.js --dry-run  … ロード〜巡回〜計算までは行うが record は呼ばない
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const fs   = require('fs');
const path = require('path');

const loadVm = require('./vm_loader');

const API_BASE      = 'https://ar-proxy.onrender.com';
const STATE_DIR     = path.join(__dirname, 'state');
const RACE_SLEEP_MS = 500;   // /race リクエスト間の間隔

const DRY_RUN = process.argv.includes('--dry-run');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 今日の日付（JST, YYYYMMDD）
function getTodayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// kaisaiId（先頭8桁 = 開催初日）と day から実際の開催日を YYYYMMDD で返す。
// kaisai.js の kaisaiActualDate と同一ロジック（day=1 なら初日、day=2 なら +1日）。
function kaisaiActualDate(kaisaiId, day) {
  const s = String(kaisaiId);
  const y = parseInt(s.slice(0, 4), 10);
  const m = parseInt(s.slice(4, 6), 10) - 1;
  const d = parseInt(s.slice(6, 8), 10);
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() + (parseInt(day, 10) - 1));
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCDate()).padStart(2, '0'),
  ].join('');
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// Render のコールドスタート（起動待ち）を考慮したリトライ付き /kaisai 取得
async function fetchKaisaiWithRetry(date) {
  const MAX_TRY = 5;
  const WAIT_MS = 15000;   // コールドスタートの起動待ちを想定した間隔
  let lastErr;
  for (let i = 1; i <= MAX_TRY; i++) {
    try {
      return await fetchJson(`${API_BASE}/kaisai?date=${date}`);
    } catch (e) {
      lastErr = e;
      console.log(`[kaisai] 取得失敗 (${i}/${MAX_TRY}): ${e.message}`);
      if (i < MAX_TRY) await sleep(WAIT_MS);
    }
  }
  throw new Error(`/kaisai 取得に ${MAX_TRY} 回失敗: ${lastErr && lastErr.message}`);
}

// ━━━━━━━━━━━━━━━━━━━━━━
// 送信済み state 管理（当日分のみ / race_id の配列）
// race_id は「venue_kaisaiId_day_raceNo」で一意化する（同一開催の同一レースを識別）。
// ━━━━━━━━━━━━━━━━━━━━━━
function stateFile(date) {
  return path.join(STATE_DIR, `sent_${date}.json`);
}

function loadSent(date) {
  try {
    const arr = JSON.parse(fs.readFileSync(stateFile(date), 'utf8'));
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch (e) {
    return new Set();
  }
}

function saveSent(date, sentSet) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(stateFile(date), JSON.stringify([...sentSet]), 'utf8');
}

// 当日以外の古い sent_*.json を削除する
function cleanupOldState(todayDate) {
  let files;
  try {
    files = fs.readdirSync(STATE_DIR);
  } catch (e) {
    return;
  }
  files.forEach(f => {
    const m = f.match(/^sent_(\d{8})\.json$/);
    if (m && m[1] !== todayDate) {
      try {
        fs.unlinkSync(path.join(STATE_DIR, f));
        console.log(`[state] 旧ファイル削除: ${f}`);
      } catch (e) {
        console.log(`[state] 旧ファイル削除失敗: ${f} (${e.message})`);
      }
    }
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━
// メイン
// ━━━━━━━━━━━━━━━━━━━━━━
async function main() {
  console.log(`[crawl] 開始 dryRun=${DRY_RUN}`);
  const today = getTodayJST();

  // 1. サンドボックスロード（HF から本番ロジックを取得）
  const vmEnv = await loadVm();
  const { ArAdapter, ArRonde, ArShadow } = vmEnv;
  console.log(`[crawl] ロジックロード完了 engine_ver=${vmEnv.engineVer || '(不明)'}`);

  // 2. 当日以外の古い state を掃除
  cleanupOldState(today);

  // 3. 当日開催を取得（コールドスタート対策リトライ付き）
  const kaisai = await fetchKaisaiWithRetry(today);
  const venues = Array.isArray(kaisai.venues) ? kaisai.venues : [];
  console.log(`[crawl] 対象日=${today} 開催=${venues.length}場`);

  const sent = loadSent(today);

  for (const v of venues) {
    const venue    = v.venue;
    const kaisaiId  = v.kaisaiId;
    const day       = v.day;
    const races     = Array.isArray(v.races) ? v.races : [];
    const raceDate  = kaisaiActualDate(kaisaiId, day);  // meta.date（YYYYMMDD）

    console.log(`[venue] ${venue} kaisaiId=${kaisaiId} day=${day} races=[${races.join(',')}]`);

    for (const raceNo of races) {
      const raceKey = `${venue}_${kaisaiId}_${day}_${raceNo}`;

      // 二重送信防止
      if (sent.has(raceKey)) {
        console.log(`[skip] ${raceKey}: 送信済み`);
        continue;
      }

      // /race 取得
      let json;
      try {
        json = await fetchJson(
          `${API_BASE}/race?venue=${venue}&kaisaiId=${kaisaiId}&day=${day}&raceNo=${raceNo}`
        );
      } catch (e) {
        console.log(`[skip] ${raceKey}: /race取得失敗 ${e.message}`);
        await sleep(RACE_SLEEP_MS);
        continue;
      }
      if (json.error || !Array.isArray(json.riders)) {
        console.log(`[skip] ${raceKey}: レース不存在/エラー応答`);
        await sleep(RACE_SLEEP_MS);
        continue;
      }

      // ── 試走フィルタ ──
      // 非欠車（isScratched=false）の選手全員の trialTime > 0 のレースのみ対象。
      // 1人でも試走タイム未取得ならスキップ。まだ試走が掲載されていないだけなので、
      // sent には記録せず、次回 cron 実行時に再判定される。
      const active = json.riders.filter(r => !r.isScratched);
      if (active.length === 0) {
        console.log(`[skip] ${raceKey}: 非欠車0名`);
        await sleep(RACE_SLEEP_MS);
        continue;
      }
      const allTrialsReady = active.every(r => typeof r.trialTime === 'number' && r.trialTime > 0);
      if (!allTrialsReady) {
        console.log(`[skip] ${raceKey}: 試走タイム未掲載（次回cronで再判定）`);
        await sleep(RACE_SLEEP_MS);
        continue;
      }

      // ── 予想パイプライン（ブラウザ ar_main.js と同一順序）──
      // ArAdapter.parseRaceData → calcRaceScores → calcLPoint → calcVolatility
      //   → generateBets → ArShadow.record
      // ※ rainFlag は ArAdapter.parseRaceData が算出した値をそのまま使用する。
      //   ar_main.js 291行付近の calcRainFlag(rateWet3, rateGood3, avgTrial, avgST, wetRaceCount) と
      //   ar_adapter.js 50-56行の calcRainFlag(rateWet_2, rateGood_2, dryAvgTrial, wetAvgTrial, wetRaceCount)
      //   では引数順が食い違っているが、本タスクではその疑義を追認・修正せず、
      //   parseRaceData の算出値をそのまま踏襲する。
      let ctx;
      try {
        const adapted = ArAdapter.parseRaceData(json);
        let scored = ArRonde.calcRaceScores(adapted.players, adapted.roadCondition);
        scored = ArRonde.calcLPoint(scored);
        const volatility = ArRonde.calcVolatility(scored);
        const bets = ArRonde.generateBets(scored);

        ctx = {
          players: scored,
          meta: {
            date:   raceDate,   // YYYYMMDD
            venue:  venue,
            raceNo: raceNo,
            // /race の JSON に laps 項目は存在しないため通常は空になる。
            // 将来 API が laps を返すようになれば自動で反映される。
            laps:   (json.laps != null) ? json.laps : '',
          },
          roadCondition: adapted.roadCondition,
          volatility,
          bets,
        };
      } catch (e) {
        console.log(`[skip] ${raceKey}: 計算失敗 ${e.message}`);
        await sleep(RACE_SLEEP_MS);
        continue;
      }

      if (DRY_RUN) {
        console.log(
          `[dry-run] ${raceKey}: record送信スキップ ` +
          `(date=${ctx.meta.date} road=${ctx.roadCondition} entries=${ctx.players.length})`
        );
      } else {
        try {
          // endpoint/token 未設定ならサイレントスキップ（何も送信されない）。
          // fetch は no-cors 相当の fire-and-forget のため送信成否は確認できない。
          // record 呼び出しをもって「送信した」とみなし state に記録する。
          ArShadow.record(ctx);
          sent.add(raceKey);
          saveSent(today, sent);
          console.log(`[sent] ${raceKey}`);
        } catch (e) {
          console.log(`[error] ${raceKey}: record失敗 ${e.message}`);
        }
      }

      await sleep(RACE_SLEEP_MS);
    }
  }

  // 最後の record の POST が in-flight のままプロセス終了で中断されないよう、
  // 少しだけドレイン待ちを入れる（no-cors fire-and-forget のため await できない）。
  if (!DRY_RUN) await sleep(2000);

  console.log('[crawl] 完了');
}

main().catch(e => {
  console.error('[crawl] 致命的エラー:', e.message);
  process.exit(1);
});
