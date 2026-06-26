const fetch = require('node-fetch');
const cheerio = require('cheerio');

const VENUE_MAP = {
  '伊勢崎': 'isesaki',
  '川口': 'kawaguchi',
  '浜松': 'hamamatsu',
  '飯塚': 'iizuka',
  '山陽': 'sanyo',
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

async function getKaisaiInfo(date) {
  // WINTICKET のレース一覧ページをスクレイプ
  // ページに含まれるリンクの kaisaiId と day から実際の開催日を算出し、
  // リクエストされた date と一致するものだけを返す。
  const url = 'https://www.winticket.jp/autorace/racecard';
  const options = {
    headers: { 'User-Agent': 'PoliteAutoBot/1.0' },
  };

  try {
    const response = await fetch(url, options);
    const body = await response.text();
    const $ = cheerio.load(body);

    const venues = {};

    $('a[href*="/autorace/"][href*="/racecard/"]').each((i, el) => {
      const href = $(el).attr('href');
      const match = href.match(/\/autorace\/(\w+)\/racecard\/(\d+)\/(\d+)\/(\d+)/);
      if (!match) return;
      const [, venueSlug, kaisaiId, day, raceNo] = match;

      if (!Object.values(VENUE_MAP).includes(venueSlug)) return;

      // kaisaiId と day から実際の開催日を算出し、date と照合する
      const actualDate = kaisaiActualDate(kaisaiId, day);
      if (actualDate !== date) return;

      if (!venues[venueSlug]) {
        venues[venueSlug] = { venue: venueSlug, kaisaiId, day: parseInt(day, 10), races: [] };
      }
      const raceNum = parseInt(raceNo, 10);
      if (!venues[venueSlug].races.includes(raceNum)) {
        venues[venueSlug].races.push(raceNum);
      }
    });

    // レース番号を昇順にソート
    for (const v of Object.values(venues)) {
      v.races.sort((a, b) => a - b);
    }

    return { date, venues: Object.values(venues) };
  } catch (error) {
    console.error('Error scraping kaisai info:', error);
    return { date, venues: [] };
  }
}

module.exports = { getKaisaiInfo };
