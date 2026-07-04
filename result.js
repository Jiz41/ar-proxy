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
 * 全クエリを横断して、払戻オッズ配列（trifecta 等）を持つ odds クエリの data を返す
 * @param {Array} queries
 * @returns {object|null}
 */
function findOddsData(queries) {
  for (const q of queries) {
    const d = q && q.state && q.state.data;
    if (d && Array.isArray(d.trifecta) && d.trifecta.length > 0) {
      return d;
    }
  }
  return null;
}

// 券種スラッグ → common クエリの的中買い目IDフィールド名
const PAYOUT_TYPE_KEYS = {
  win:           'winWinningOddsIds',
  show:          'showWinningOddsIds',
  trifecta:      'trifectaWinningOddsIds',
  trio:          'trioWinningOddsIds',
  exacta:        'exactaWinningOddsIds',
  quinella:      'quinellaWinningOddsIds',
  quinellaPlace: 'quinellaPlaceWinningOddsIds',
};

/**
 * odds クエリの data から id→entry の Map 群を構築する
 * @param {object|null} oddsData
 * @returns {object} スラッグ → Map(id → entry)
 */
function buildOddsIndex(oddsData) {
  const index = {};
  for (const slug of Object.keys(PAYOUT_TYPE_KEYS)) {
    const map = new Map();
    const arr = oddsData && Array.isArray(oddsData[slug]) ? oddsData[slug] : [];
    for (const e of arr) {
      if (e && e.id != null) map.set(String(e.id), e);
    }
    index[slug] = map;
  }
  return index;
}

/**
 * common クエリの的中買い目IDを payoffUnitPrice に解決する
 * @param {object} data       - common クエリの data
 * @param {object} oddsIndex  - buildOddsIndex の戻り値
 * @returns {object} スラッグ → [{ combination:number[], payoff:number|null }]
 */
function resolvePayouts(data, oddsIndex) {
  const payouts = {};
  for (const slug of Object.keys(PAYOUT_TYPE_KEYS)) {
    const idField = PAYOUT_TYPE_KEYS[slug];
    const ids = Array.isArray(data[idField]) ? data[idField] : [];
    payouts[slug] = ids.map(id => {
      const entry = oddsIndex[slug].get(String(id));
      if (entry) {
        return {
          combination: Array.isArray(entry.key) ? entry.key : null,
          payoff: typeof entry.payoffUnitPrice === 'number' ? entry.payoffUnitPrice : null,
        };
      }
      return { combination: null, payoff: null, id: String(id) };
    });
  }
  return payouts;
}

/**
 * 開催ID先頭8桁（初日）と日目から期待日付 YYYYMMDD を算出する
 */
function deriveExpectedDate(kaisaiId, day) {
  const s = String(kaisaiId).slice(0, 8);
  const d = new Date(Date.UTC(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8)));
  d.setUTCDate(d.getUTCDate() + (Number(day) - 1));
  const p = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}`;
}

/**
 * オートレース着順データを取得する
 * @param {string} venue     - slug (kawaguchi など)
 * @param {string} kaisaiId  - 開催ID (例: 2026060102)
 * @param {string|number} day
 * @param {string|number} raceNo
 */
async function getResultData(venue, kaisaiId, day, raceNo) {
  const url = `https://api.winticket.jp/v1/autorace/cups/${kaisaiId}/schedules/${day}/races/${raceNo}`;

  const apiFetchOptions = {
    ...fetchOptions,
    headers: {
      ...fetchOptions.headers,
      'Accept': 'application/json',
    },
  };

  const res = await fetch(url, apiFetchOptions);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const data = await res.json();

  // 日付検証（誤った日目指定で別日の結果が混入するのを防ぐ。fail-closed）
  const expectedDate = deriveExpectedDate(kaisaiId, day);
  if (!data.schedule || !data.schedule.date) {
    throw new Error(`日付検証不能: scheduleが応答に無い (${kaisaiId}/${day}/R${raceNo})`);
  }
  if (data.schedule.date !== expectedDate) {
    throw new Error(`日付不一致: 期待${expectedDate} 実際${data.schedule.date} (${kaisaiId}/${day}/R${raceNo})`);
  }

  // ── 旧HTML抽出方式（API遮断時の懐刀。復活させる場合はこのブロックを解凍し下のAPI取得を無効化）──
  // const html = await res.text();
  //
  // // __PRELOADED_STATE__ を切り出す
  // const marker = 'window.__PRELOADED_STATE__ =';
  // let jsonStr;
  // try {
  //   jsonStr = extractJsonByBraceDepth(html, marker);
  // } catch (e) {
  //   throw new Error(`__PRELOADED_STATE__ 抽出失敗: ${e.message}`);
  // }
  //
  // let state;
  // try {
  //   state = JSON.parse(jsonStr);
  // } catch (e) {
  //   throw new Error(`__PRELOADED_STATE__ JSON.parse失敗: ${e.message}`);
  // }
  //
  // // tanStackQuery クエリ群から results を持つものを特定
  // const queries = state &&
  //   state.tanStackQuery &&
  //   state.tanStackQuery.queries;
  // if (!Array.isArray(queries)) {
  //   throw new Error('tanStackQuery.queries が見つかりません');
  // }
  //
  // const data = findResultsQuery(queries);
  // if (!data) {
  //   throw new Error('data.results を持つクエリが見つかりません');
  // }

  // 払戻（odds 配列はトップレベル）を解決する ── 着順取得とは独立の追加処理
  const oddsData   = data;
  const oddsIndex  = buildOddsIndex(oddsData);
  const payouts    = resolvePayouts(data, oddsIndex);
  const payout_3rentan = payouts.trifecta.length && payouts.trifecta[0].payoff != null
    ? payouts.trifecta[0].payoff : null;
  const payout_2rentan = payouts.exacta.length && payouts.exacta[0].payoff != null
    ? payouts.exacta[0].payoff : null;

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
      changeVehicle:        r.changeVehicle === true ? 1 : 0,
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
    payout_3rentan,
    payout_2rentan,
    payouts,
  };
}

module.exports = { getResultData };
