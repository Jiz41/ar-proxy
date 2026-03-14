const puppeteer = require('puppeteer');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const VENUES = ['kawaguchi', 'isesaki', 'hamamatsu', 'iizuka', 'sanyou'];

async function fetchText(url) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('PoliteArBot/1.0 (on-demand only, no flood; say the word and I vanish; DM: https://x.com/kayoutouidou01)');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const text = await page.evaluate(() => document.body.innerText);
    return text;
  } finally {
    await browser.close();
  }
}

async function scrapeRace(venue, date, raceNo) {
  if (!VENUES.includes(venue)) throw new Error('Invalid venue: ' + venue);

  const base = `https://autorace.jp/race_info/Live/${venue}/Program/${date}_${raceNo}`;

  const program  = await fetchText(`${base}/program`);  await sleep(1000);
  const recent10 = await fetchText(`${base}/recent10`); await sleep(1000);
  const good5    = await fetchText(`${base}/good5`);    await sleep(1000);
  const wet5     = await fetchText(`${base}/wet5`);

  return { venue, date, raceNo, program, recent10, good5, wet5 };
}

module.exports = { scrapeRace };