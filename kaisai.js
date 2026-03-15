const fetch = require('node-fetch');
const cheerio = require('cheerio');

// Mapping from Japanese venue names to English IDs
const VENUE_MAP = {
  '伊勢崎': 'isesaki',
  '川口': 'kawaguchi',
  '浜松': 'hamamatsu',
  '飯塚': 'iizuka',
  '山陽': 'sanyo',
};

async function getKaisaiInfo(date) {
  const url = 'https://www.winticket.jp/autorace/racecard';
  const options = {
    headers: {
      'User-Agent': 'PoliteAutoBot/1.0',
    },
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
      const validSlugs = Object.values(VENUE_MAP);
      if (!validSlugs.includes(venueSlug)) return;
      if (!venues[venueSlug]) {
        venues[venueSlug] = { venue: venueSlug, kaisaiId, day: parseInt(day, 10), races: [] };
      }
      venues[venueSlug].races.push(parseInt(raceNo, 10));
    });

    return { date, venues: Object.values(venues) };
  } catch (error) {
    console.error('Error scraping kaisai info:', error);
    // In case of an error, it's better to return an empty list than to crash
    return {
        date: date,
        venues: []
    };
  }
}

module.exports = { getKaisaiInfo };
