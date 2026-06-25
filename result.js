const fetch = require('node-fetch');

const VENUE_ID_MAP = {
  kawaguchi: '2',
  isesaki:   '3',
  hamamatsu: '4',
  iizuka:    '5',
  sanyo:     '6',
};

const fetchOptions = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 ar-proxy/1.0 (autorace prediction tool; https://github.com/Jiz41/ar-proxy)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ja,en;q=0.9',
    'X-Platform-Type': 'web'
  }
};

/**
 * ブレース深度カウントで JSON オブジェクトを切り出す
 * @param {string} html
 * @param {string} marker  - この文字列の直後からJSONが始まる
 * @returns {string} JSON文字列
 */
function extractJsonByBraceDepth(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(`Marker not found: ${marker}`);

  let i = start + marker.length;
  // 先頭の空白をスキップ
  while (i < html.length && /\s/.test(html[i])) i++;

  if (html[i] !== '{') throw new Error('Expected { after marker');

  let depth = 0;
  let inString = false;
  let escape = false;
  const begin = i;

  for (; i < html.length; i++) {
    const ch = html[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return html.slice(begin, i + 1);
    }
  }
  throw new Error('JSON object not closed');
}

/**
 * tanStackQuery.queries から data.results が配列のクエリを返す
 */
function findResultsQuery(queries) {
  for (const q of queries) {
    if (
      q &&
      q.state &&
      q.state.data &&
      Array.isArray(q.state.data.results)
    ) {
      return q.state.data;
    }
  }
  return null;
}

/**
 * オートレース着順データを取得する
 * @param {string} venue     - slug (kawaguchi など)
 * @param {string} kaisaiId  - 開催ID (例: 2026060102)
 * @param {string|number} day
 * @param {string|number} raceNo
 */
async function getResultData(venue, kaisaiId, day, raceNo) {
  const url = `https://www.winticket.jp/autorace/${venue}/raceresult/${kaisaiId}/${day}/${raceNo}`;

  const res = await fetch(url, fetchOptions);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const html = await res.text();

  // __PRELOADED_STATE__ を切り出す
  const marker = 'window.__PRELOADED_STATE__ =';
  let jsonStr;
  try {
    jsonStr = extractJsonByBraceDepth(html, marker);
  } catch (e) {
    throw new Error(`__PRELOADED_STATE__ 抽出失敗: ${e.message}`);
  }

  let state;
  try {
    state = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`__PRELOADED_STATE__ JSON.parse失敗: ${e.message}`);
  }

  // tanStackQuery クエリ群から results を持つものを特定
  const queries = state &&
    state.tanStackQuery &&
    state.tanStackQuery.queries;
  if (!Array.isArray(queries)) {
    throw new Error('tanStackQuery.queries が見つかりません');
  }

  const data = findResultsQuery(queries);
  if (!data) {
    throw new Error('data.results を持つクエリが見つかりません');
  }

  const { results, race, entries, players } = data;

  // playerId → { number, sunnyOrder, rainyOrder } のマップ（entries から）
  const entryMap = {};
  if (Array.isArray(entries)) {
    for (const e of entries) {
      entryMap[String(e.playerId)] = {
        number:     e.number,
        sunnyOrder: e.sunnyOrder ?? 0,
        rainyOrder: e.rainyOrder ?? 0,
      };
    }
  }

  // playerId → player のマップ（players から）
  const playerMap = {};
  if (Array.isArray(players)) {
    for (const p of players) {
      playerMap[String(p.id)] = p;
    }
  }

  // 会場のvenueId
  const venueId = VENUE_ID_MAP[venue] || null;

  // results を整形
  const formattedResults = results.map(r => {
    const pid = String(r.playerId);
    const player = playerMap[pid] || {};
    const entry  = entryMap[pid]  || {};
    const homeFlag =
      venueId && player.lockerGroundVenueId === venueId ? 1 : 0;

    return {
      carNum:               entry.number || null,
      playerId:             pid,
      order:                r.order,
      handicap:             r.handicap,
      trialRecord:          r.trialRecord,
      startTiming:          r.startTiming,
      recommendationPoint:  r.recommendationPoint,
      record:               r.record,
      homeFlag,
      sunnyOrder:           entry.sunnyOrder ?? 0,
      rainyOrder:           entry.rainyOrder ?? 0,
    };
  });

  // 着順でソート
  formattedResults.sort((a, b) => a.order - b.order);

  return {
    venue,
    kaisaiId,
    day:            Number(day),
    raceNo:         Number(raceNo),
    trackCondition: race ? race.trackCondition : null,
    weather:        race ? race.weather        : null,
    temperature:    race ? race.temperature    : null,
    humidity:       race ? race.humidity       : null,
    results:        formattedResults,
  };
}

module.exports = { getResultData };
