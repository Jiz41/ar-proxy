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

// Simple helper to get the English venue ID from a string that might contain the Japanese name
const getVenueId = (name) => {
    for (const [key, value] of Object.entries(VENUE_MAP)) {
        if (name.includes(key)) {
            return value;
        }
    }
    return null;
}

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

    const venues = [];

    $('div.p-raceCard-venues-list-item').each((i, el) => {
      const venueElement = $(el);

      const venueName = venueElement.find('p.p-raceCard-venues-list-item__name').text();
      const venueId = getVenueId(venueName);
      
      if (!venueId) {
        return; // Skip if venue not found in our map
      }
      
      const races = [];
      let kaisaiId = null;
      let day = null;

      venueElement.find('a.p-raceCard-race-list-item').each((j, raceEl) => {
        const raceLink = $(raceEl).attr('href');
        const raceNumberText = $(raceEl).find('p.p-raceCard-race-list-item__number').text();
        const raceNumberMatch = raceNumberText.match(/(\d+)/);

        if (raceNumberMatch) {
            races.push(parseInt(raceNumberMatch[1], 10));
        }

        if (!kaisaiId && raceLink) {
            const match = raceLink.match(/\/racecard\/(\d+)\/(\d+)\/\d+/);
            if (match) {
              kaisaiId = match[1];
              day = parseInt(match[2], 10);
            }
        }
      });

      if (kaisaiId) {
        venues.push({
          venue: venueId,
          kaisaiId: kaisaiId,
          day: day,
          races: races,
        });
      }
    });

    return {
      date: date,
      venues: venues,
    };
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
