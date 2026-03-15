const express = require('express');
const { scrapeRaceData } = require('./scraper');

const app = express();
const port = process.env.PORT || 3000;

app.get('/race', async (req, res) => {
  const { venue, kaisaiId, day, raceNo } = req.query;

  if (!venue || !kaisaiId || !day || !raceNo) {
    return res.status(400).json({ error: 'venue, kaisaiId, day, and raceNo are required' });
  }

  try {
    const data = await scrapeRaceData(venue, kaisaiId, day, raceNo);
    if (data.error) {
        res.status(500).json(data);
    } else {
        res.json(data);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});