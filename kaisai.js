const fetch = require('node-fetch');
const cheerio = require('cheerio');

const VENUE_MAP = {
  '伊勢崎': 'isesaki',
  '川口': 'kawaguchi',
  '浜松': 'hamamatsu',
  '飯塚': 'iizuka',
  '山陽': 'sanyo',
};

const fetchOptions = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 ar-proxy/1.0 (autorace prediction tool; https://github.com/Jiz41/ar-proxy)',
    'Accept': 'application/json',
  },
};

/**
 * kaisaiId（例: 2026062402）と day 番号から
 * その日の実際の開催日を YYYYMMDD 文字列で返す。
 * kaisaiId の先頭8桁 = 開催初日。day=2 なら +1日。
 */
function kaisaiActualDate(kaisaiId, day) {
  const y = parseInt(kaisaiId.slice(0, 4), 10);
  const m = parseInt(kaisaiId.slice(4, 6), 10) - 1;
  const d = parseInt(kaisaiId.slice(6, 8), 10);
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() + (parseInt(day, 10) - 1));
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCDate()).padStart(2, '0'),
  ].join('');
}

/**
 * 指定日（YYYYMMDD）の開催情報を WINTICKET 内部API から取得する。
 * monthlyCups で日付を含む開催を絞り、各開催詳細の schedules で
 * 当該日の day / kaisaiId / レース一覧を解決する。
 * @param {string} date - 'YYYYMMDD'
 */
async function getKaisaiInfo(date) {
  try {
    const cupsRes = await fetch('https://api.winticket.jp/v1/autorace/cups', fetchOptions);
    if (!cupsRes.ok) {
      throw new Error(`HTTP ${cupsRes.status} fetching cups`);
    }
    const cupsData = await cupsRes.json();
    const monthlyCups = Array.isArray(cupsData.monthlyCups) ? cupsData.monthlyCups : [];

    // date が開催期間に含まれる開催を候補として抽出（文字列比較）
    const candidates = monthlyCups.filter(
      c => c && c.startDate <= date && date <= c.endDate
    );

    const venues = [];

    for (const cand of candidates) {
      const cupId = cand.id;
      const detailRes = await fetch(
        `https://api.winticket.jp/v1/autorace/cups/${cupId}`,
        fetchOptions
      );
      if (!detailRes.ok) {
        throw new Error(`HTTP ${detailRes.status} fetching cup ${cupId}`);
      }
      const detail = await detailRes.json();

      const schedules = Array.isArray(detail.schedules) ? detail.schedules : [];
      const schedule = schedules.find(s => s && s.date === date);
      if (!schedule) continue;

      const races = Array.isArray(detail.races) ? detail.races : [];
      const raceNums = [
        ...new Set(
          races
            .filter(r => r && r.scheduleId === schedule.id)
            .map(r => r.number)
        ),
      ].sort((a, b) => a - b);

      venues.push({
        venue: detail.venue ? detail.venue.slug : null,
        kaisaiId: cupId,
        day: schedule.day,
        actualDate: date,
        races: raceNums,
      });
    }

    return { date, venues };
  } catch (error) {
    console.error('Error fetching kaisai info:', error);
    return { date, venues: [] };
  }
}

// ── 旧HTMLスクレイピング方式（API遮断時の懐刀。復活させる場合はこのブロックを解凍し上のAPI版を無効化）──
// async function getKaisaiInfo(date) {
//   // WINTICKET のレース一覧ページをスクレイプ
//   // ページに含まれるリンクの kaisaiId と day から実際の開催日を算出し、
//   // リクエストされた date と一致するものだけを返す。
//   const url = 'https://www.winticket.jp/autorace/racecard';
//   const options = {
//     headers: { 'User-Agent': 'PoliteAutoBot/1.0' },
//   };
//
//   try {
//     const response = await fetch(url, options);
//     const body = await response.text();
//     const $ = cheerio.load(body);
//
//     const venues = {};
//
//     $('a[href*="/autorace/"][href*="/racecard/"]').each((i, el) => {
//       const href = $(el).attr('href');
//       const match = href.match(/\/autorace\/(\w+)\/racecard\/(\d+)\/(\d+)\/(\d+)/);
//       if (!match) return;
//       const [, venueSlug, kaisaiId, day, raceNo] = match;
//
//       if (!Object.values(VENUE_MAP).includes(venueSlug)) return;
//
//       // kaisaiId と day から実際の開催日を算出する（フィルタはせず表示用に保持）
//       const actualDate = kaisaiActualDate(kaisaiId, day);
//
//       if (!venues[venueSlug]) {
//         venues[venueSlug] = { venue: venueSlug, kaisaiId, day: parseInt(day, 10), actualDate, races: [] };
//       }
//       const raceNum = parseInt(raceNo, 10);
//       if (!venues[venueSlug].races.includes(raceNum)) {
//         venues[venueSlug].races.push(raceNum);
//       }
//     });
//
//     // レース番号を昇順にソート
//     for (const v of Object.values(venues)) {
//       v.races.sort((a, b) => a - b);
//     }
//
//     return { date, venues: Object.values(venues) };
//   } catch (error) {
//     console.error('Error scraping kaisai info:', error);
//     return { date, venues: [] };
//   }
// }

module.exports = { getKaisaiInfo };
