const express = require('express');
const { scrapeRaceData } = require('./scraper');
const { getKaisaiInfo } = require('./kaisai');
const { getResultData } = require('./result');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;
app.use(cors());

app.get('/race', async (req, res) => {
  const { venue, kaisaiId, day, raceNo } = req.query;
  if (!venue || !kaisaiId || !day || !raceNo) {
    return res.status(400).json({ error: 'venue, kaisaiId, day, and raceNo are required' });
  }
  try {
    const data = await scrapeRaceData(venue, kaisaiId, day, raceNo);
    if (data.error) { res.status(500).json(data); }
    else { res.json(data); }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/kaisai', async (req, res) => {
  const { date } = req.query;
  if (!date) { return res.status(400).json({ error: 'date is required' }); }
  try {
    const data = await getKaisaiInfo(date);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/result', async (req, res) => {
  const { venue, kaisaiId, day, raceNo } = req.query;
  if (!venue || !kaisaiId || !day || !raceNo) {
    return res.status(400).json({ error: 'venue, kaisaiId, day, and raceNo are required' });
  }
  try {
    const data = await getResultData(venue, kaisaiId, day, raceNo);
    if (data.error) { res.status(500).json(data); }
    else { res.json(data); }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => { console.log(`Server is running on port ${port}`); });
