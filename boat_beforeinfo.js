// ボートレース戸田 公式直前情報の中継モジュール
// 移植元: jzirtboat/scripts/serve.mjs（パーサー・キャッシュ・キューを忠実移植、CommonJS化のみ）
//
// 直前情報アクセス憲章（厳守）:
//   - 同一(date,race)は CACHE_TTL_MS の間メモリキャッシュし再fetchしない
//   - 異なるレースへの連続fetchにも MIN_FETCH_INTERVAL_MS の間隔を必ず空ける（キュー化）
//   - UAは一般ブラウザ相当を送る

const CACHE_TTL_MS = 10 * 60 * 1000; // 10分
const MIN_FETCH_INTERVAL_MS = 2000; // 異なるレース間の最低間隔
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TODA_JCD = '02';

// ============================================================
// 直前情報キャッシュ＋フェッチキュー
// ============================================================

const cache = new Map(); // key(`${date}-${race}`) -> { ts, data }
let lastFetchAt = 0;
let fetchQueue = Promise.resolve();

function enqueueFetch(task) {
  const run = fetchQueue.then(async () => {
    const wait = MIN_FETCH_INTERVAL_MS - (Date.now() - lastFetchAt);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastFetchAt = Date.now();
    return task();
  });
  // キュー自体はエラーで途切れさせない（後続タスクの実行を妨げないため）
  fetchQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function beforeInfoUrl(dateStr, raceNo) {
  return `https://www.boatrace.jp/owpc/pc/race/beforeinfo?rno=${raceNo}&jcd=${TODA_JCD}&hd=${dateStr}`;
}

async function fetchBeforeInfo(dateStr, raceNo) {
  const key = `${dateStr}-${raceNo}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { data: cached.data, cached: true };
  }

  const data = await enqueueFetch(async () => {
    const url = beforeInfoUrl(dateStr, raceNo);
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      throw new Error(`beforeinfo HTTP ${res.status}`);
    }
    const html = await res.text();
    return parseBeforeInfoHtml(html);
  });

  cache.set(key, { ts: Date.now(), data });
  return { data, cached: false };
}

// ============================================================
// HTMLパーサー（boatrace.jp beforeinfo 専用）
// セレクタ・構造の根拠は jzirtboat/docs/format_notes.md「公式直前情報ページ」章を参照。
// 構造変化で壊れた時はこの関数群のみを直せばよい。
// ============================================================

function decodeEntities(raw) {
  if (raw == null) return null;
  return raw.replace(/&nbsp;/g, '').replace(/&amp;/g, '&').trim();
}

function cellValue(raw) {
  const v = decodeEntities(raw);
  return v === '' || v == null ? null : v;
}

function numOrNull(raw) {
  const v = cellValue(raw);
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

function isNoDataPage(html) {
  return html.includes('データがありません');
}

// 選手情報テーブル（6艇分）: 体重・調整重量・展示タイム・チルト・プロペラ・部品交換。
// 展示タイム/チルト/プロペラは展示走行前は&nbsp;（=null）のまま返る。
function parseBoatInfoTable(html) {
  const blocks = html.split(/<tbody class="is-fs12\s*">/).slice(1);
  return blocks.map((block) => {
    const boatMatch = block.match(/is-boatColor(\d)/);
    const boat = boatMatch ? Number(boatMatch[1]) : null;

    const weightMatch = block.match(/rowspan="2">([^<]*)<\/td>/);
    const weight = weightMatch ? numOrNull(weightMatch[1].replace('kg', '')) : null;

    // 体重セル直後に続く3つの rowspan="4" td = 展示タイム / チルト / プロペラ
    const row1Match = block.match(
      /rowspan="2">[^<]*<\/td>\s*<td rowspan="4">([^<]*)<\/td>\s*<td rowspan="4">([^<]*)<\/td>\s*<td rowspan="4">([^<]*)<\/td>/
    );
    const exhibitionTime = row1Match ? numOrNull(row1Match[1]) : null;
    const tilt = row1Match ? cellValue(row1Match[2]) : null;
    const propellerChanged = row1Match ? cellValue(row1Match[3]) : null;

    const adjustMatch = block.match(/rowspan="2">([^<]*)<\/td>\s*<td>ST<\/td>/);
    const adjustWeight = adjustMatch ? numOrNull(adjustMatch[1]) : null;

    const partsExchange = [...block.matchAll(/<li><span class="label4[^"]*">([^<]*)<\/span><\/li>/g)]
      .map((m) => decodeEntities(m[1]))
      .filter((v) => v);

    return { boat, weight, adjustWeight, exhibitionTime, tilt, propellerChanged, partsExchange };
  });
}

// スタート展示テーブル（進入予想/コース/並び/ST）。
// 展示前は各行が <td colspan="3"> の空セルであることを確認済み。
// 展示後の実セル構造は未確認のため、想定外の形が来ても例外を投げず該当行をnullにする防御的実装。
// 対応関係（何行目がどの艇か）も未確認につき、raw配列としてのみ返す（呼び出し側での艇番対応付けはしない）。
function parseStartExhibitionTable(html) {
  const tableMatch = html.match(/is-w238"[\s\S]*?<tbody class="is-p10-0">([\s\S]*?)<\/tbody>/);
  if (!tableMatch) return { available: false, rows: [] };

  const rowsHtml = [...tableMatch[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  let anyPopulated = false;
  const rows = rowsHtml.map((rowHtml) => {
    if (/colspan="3"/.test(rowHtml)) {
      return null;
    }
    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => cellValue(m[1]));
    if (cells.length < 3) return null;
    anyPopulated = true;
    return { course: numOrNull(cells[0]), formation: cells[1], st: numOrNull(cells[2]) };
  });

  return { available: anyPopulated, rows };
}

// 水面気象情報。展示前後を問わず常時取得可能。
function parseWeather(html) {
  const labelData = (cls) => {
    const re = new RegExp(`class="weather1_bodyUnit ${cls}">[\\s\\S]*?weather1_bodyUnitLabelData">([^<]*)<`);
    const m = html.match(re);
    return m ? m[1] : null;
  };

  const temperature = numOrNull(labelData('is-direction'));
  const weatherLabelMatch = html.match(
    /class="weather1_bodyUnit is-weather">[\s\S]*?weather1_bodyUnitLabelTitle">([^<]*)</
  );
  const weatherLabel = weatherLabelMatch ? decodeEntities(weatherLabelMatch[1]) : null;
  const windSpeed = numOrNull(labelData('is-wind'));
  const windDirMatch = html.match(/class="weather1_bodyUnit is-windDirection">[\s\S]*?is-wind(\d+)"/);
  // 方角名のテキストラベルはページ内に存在しない（アイコンclass番号のみ）。
  // NN→方角名の対応表は未確認のため windDirectionLabel は常にnull（正直な報告）。
  const windDirectionIconNumber = windDirMatch ? Number(windDirMatch[1]) : null;
  const waterTemperature = numOrNull(labelData('is-waterTemperature'));
  const waveHeight = numOrNull(labelData('is-wave'));

  return {
    temperature,
    weatherLabel,
    windSpeed,
    windDirectionIconNumber,
    windDirectionLabel: null,
    waterTemperature,
    waveHeight
  };
}

function parseBeforeInfoHtml(html) {
  if (isNoDataPage(html)) {
    return { noData: true };
  }
  const boats = parseBoatInfoTable(html);
  const startExhibition = parseStartExhibitionTable(html);
  const weather = parseWeather(html);
  return { noData: false, boats, startExhibition, weather };
}

// Expressハンドラ本体（GET /boat/beforeinfo?date=YYYYMMDD&race=N）
async function handleBoatBeforeInfo(req, res) {
  const dateStr = req.query.date;
  const raceNo = Number(req.query.race);

  if (!dateStr || !/^\d{8}$/.test(dateStr)) {
    return res.status(400).json({ ok: false, error: 'invalid_date' });
  }
  if (!Number.isInteger(raceNo) || raceNo < 1 || raceNo > 12) {
    return res.status(400).json({ ok: false, error: 'invalid_race' });
  }

  try {
    const { data, cached } = await fetchBeforeInfo(dateStr, raceNo);
    if (data.noData) {
      return res.status(200).json({ ok: false, error: 'no_data', cached });
    }
    return res.status(200).json({ ok: true, cached, data });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'fetch_failed', message: err.message });
  }
}

module.exports = { handleBoatBeforeInfo, parseBeforeInfoHtml, fetchBeforeInfo };
