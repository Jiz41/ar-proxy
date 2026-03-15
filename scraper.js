const fetch = require('node-fetch');
const cheerio = require('cheerio');

async function scrapeRaceCard(venue, kaisaiId, day, raceNo) {
  const url = `https://www.winticket.jp/autorace/${venue}/racecard/${kaisaiId}/${day}/${raceNo}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { error: `Failed to fetch data: ${response.statusText}` };
    }
    const html = await response.text();
    const $ = cheerio.load(html);

    const nuxtDataScript = $('script:contains("window.__NUXT__")').html();
    if (!nuxtDataScript) {
        return { error: 'Could not find __NUXT__ data.' };
    }

    const nuxtData = JSON.parse(nuxtDataScript.match(/window\.__NUXT__=([^;]*);/)[1]);

    const race = nuxtData.data[0].race;
    const riders = race.raceCardRiders.map(rider => ({
        carNum: rider.carNum,
        name: rider.rider.name,
        base: rider.rider.branch.name,
        period: rider.rider.period,
        age: rider.rider.age,
        handicap: rider.handicap,
        st: rider.st,
        trialTime: rider.trialTime,
        deviation: rider.deviation,
        auditPoint: rider.auditPoint,
        auditRankCurrent: rider.auditRankCurrent,
        auditRankPrev: rider.auditRankPrev,
        win1_10: rider.win1_10,
        win2_10: rider.win2_10,
        win3_10: rider.win3_10,
        out_10: rider.out_10,
        rate90_2: rider.rate90_2,
        rate90_3: rider.rate90_3,
        rateGood_2: rider.rateGood_2,
        rateGood_3: rider.rateGood_3,
        rateWet_2: rider.rateWet_2,
        rateWet_3: rider.rateWet_3,
    }));

    return {
      venue: race.venue.key,
      kaisaiId: race.kaisaiId,
      day: race.day,
      raceNo: race.raceNo,
      condition: race.condition.name,
      riders,
    };
  } catch (error) {
    return { error: error.message };
  }
}

// This part is for command line execution
(async () => {
    // process.argv will be: ['node', 'scraper.js', 'venue', 'kaisaiId', 'day', 'raceNo']
    const [,, venue, kaisaiId, day, raceNo] = process.argv;

    if (venue && kaisaiId && day && raceNo) {
      const data = await scrapeRaceCard(venue, kaisaiId, day, raceNo);
      console.log(JSON.stringify(data, null, 2));
    }
})();

// For use in other files
module.exports = scrapeRaceCard;