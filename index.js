const express = require('express');
const { scrapeRace } = require('./scraper');

const app = express();
const port = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.get('/', (req, res) => res.send('ok'));

// URL構造:
// ベース: https://autorace.jp/race_info/Live/{venue}/Program/{date}_{raceNo}/{tab}
// タブ: program / recent10 / good5 / wet5
// 会場: kawaguchi / isesaki / hamamatsu / iizuka / sanyou
// 例: /race?venue=hamamatsu&date=2026-03-14&raceNo=5

app.get('/race', async (req, res) => {
  const { venue, date, raceNo } = req.query;
  if (!venue || !date || !raceNo) {
    return res.status(400).json({ error: 'venue, date, raceNo are required' });
  }
  try {
    const data = await scrapeRace(venue, date, raceNo);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});