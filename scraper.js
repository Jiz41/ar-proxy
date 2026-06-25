const fetch = require('node-fetch');
const cheerio = require('cheerio');

const parseFloatSafe = (str) => {
    if (typeof str !== 'string') return null;
    const num = parseFloat(str.replace('%', ''));
    return isNaN(num) ? null : num;
};

const parseIntSafe = (str) => {
    if (typeof str !== 'string') return null;
    const num = parseInt(str, 10);
    return isNaN(num) ? null : num;
};

async function scrapeRaceCard(venue, kaisaiId, day, raceNo) {
    const url1 = `https://www.winticket.jp/autorace/${venue}/racecard/${kaisaiId}/${day}/${raceNo}`;
    const url2 = `${url1}?type=previous`;

    const fetchOptions = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 ar-proxy/1.0 (autorace prediction tool; https://github.com/Jiz41/ar-proxy)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ja,en;q=0.9',
            'X-Platform-Type': 'web'
        }
    };

    let recentRacesByCarNum = {};

    try {
        const [response1, response2] = await Promise.all([
            fetch(url1, fetchOptions),
            fetch(url2, fetchOptions)
        ]);

        if (!response1.ok) {
            return { error: `Failed to fetch data from URL1: ${response1.statusText}` };
        }

        if (response2.ok) {
            const html2 = await response2.text();
            const $2 = cheerio.load(html2);
            
            $2('table').eq(1).find('tr').each((i, row) => {
                const tds = $2(row).find('td').map((j, td) => $2(td).text().trim()).get();
                if (tds.length === 0) return;

                const carNum = parseIntSafe(tds[0]);
                if (!carNum) return;

                const recentRaces = [];
                const raceHistoryCells = tds.slice(4);
                const raceRegex = /(\d{2}\/\d{2})([^\d]+?)(\d+)R([^\d]+?)(\d+)(\d+\.\d{3})(\d+)m\s*(?:再)?試(\d+\.\d+)ST(\d+\.\d+)/;

                for (const cellText of raceHistoryCells) {
                    const match = cellText.match(raceRegex);
                    if (match) {
                        recentRaces.push({
                            date: match[1],
                            venue: match[2].trim(),
                            raceNo: parseIntSafe(match[3]),
                            condition: match[4],
                            rank: parseIntSafe(match[5]),
                            raceTime: parseFloatSafe(match[6]),
                            handicap: parseIntSafe(match[7]),
                            trialTime: parseFloatSafe(match[8]),
                            st: parseFloatSafe(match[9]),
                        });
                    }
                }

                if (recentRaces.length > 0) {
                    const trials = recentRaces.map(r => r.trialTime).filter(t => t !== null && !isNaN(t));
                    const avgTrial = trials.length > 0 ? trials.reduce((a, b) => a + b, 0) / trials.length : 0;

                    const sts = recentRaces.map(r => r.st).filter(st => st !== null && !isNaN(st));
                    const avgST = sts.length > 0 ? sts.reduce((a, b) => a + b, 0) / sts.length : 0;
                    
                    const dryTrials = recentRaces.filter(r => r.condition === '良').map(r => r.trialTime).filter(t => t !== null && !isNaN(t));
                    const dryAvgTrial = dryTrials.length > 0 ? dryTrials.reduce((a, b) => a + b, 0) / dryTrials.length : 0;

                    const wetRaces = recentRaces.filter(r => r.condition === '湿');
                    const wetTrials = wetRaces.map(r => r.trialTime).filter(t => t !== null && !isNaN(t));
                    const wetAvgTrial = wetTrials.length > 0 ? wetTrials.reduce((a, b) => a + b, 0) / wetTrials.length : 0;
                    const wetRaceCount = wetRaces.length;

                    recentRacesByCarNum[carNum] = {
                        recentRaces,
                        avgTrial: parseFloat(avgTrial.toFixed(3)),
                        avgST: parseFloat(avgST.toFixed(3)),
                        dryAvgTrial: parseFloat(dryAvgTrial.toFixed(3)),
                        wetAvgTrial: parseFloat(wetAvgTrial.toFixed(3)),
                        wetRaceCount
                    };
                }
            });
        } else {
            console.warn(`Failed to fetch data from URL2: ${response2.statusText}`);
        }

        const html = await response1.text();
        const $ = cheerio.load(html);

        const bodyText = $('body').text();
        const condMatch = bodyText.match(/(良走路|湿走路|斑走路)/);
        let condition = condMatch ? condMatch[1] : null;

        const riders = [];
        const tableRows = $('table').eq(1).find('tr');

        for (let i = 2; i < tableRows.length; i += 2) {
            const mainRow = tableRows.eq(i);
            const subRow = tableRows.eq(i + 1);

            if (!mainRow.length || !subRow.length) continue;

            const mainCells = mainRow.find('td');
            const subCells = subRow.find('td');

            const carNum = parseIntSafe($(mainCells[0]).text().trim());

            const nameStr = $(mainCells[1]).text().trim();
            const nameMatch = nameStr.match(/^(.+?)(\d+)期\s*(\d+)歳\s*(.+)$/);
            const name = nameMatch ? nameMatch[1] : nameStr;
            const period = nameMatch ? parseIntSafe(nameMatch[2]) : null;
            const age = nameMatch ? parseIntSafe(nameMatch[3]) : null;
            const base = nameMatch ? nameMatch[4] : null;

            const handicapStr = $(mainCells[2]).text().trim();
            const [handicapVal, stVal] = handicapStr.split('m');
            const handicap = parseIntSafe(handicapVal);
            const st = parseFloatSafe(stVal);

            const trialStr = $(mainCells[3]).text().trim().replace(/\s/g, '');
            const trialMatch = trialStr.match(/^(\d+\.\d+)(\d+\.\d+)$/);
            const trialTime = trialMatch ? parseFloatSafe(trialMatch[1]) : parseFloatSafe(trialStr);
            const deviation = trialMatch ? parseFloatSafe(trialMatch[2]) : null;

            const auditStr = $(mainCells[4]).text().trim();
            const auditMatch = auditStr.match(/([\d.]+)([A-Z]+-\d+)\((.*)\)/);
            const auditPoint = auditMatch ? parseFloatSafe(auditMatch[1]) : null;
            const auditRankCurrent = auditMatch ? auditMatch[2] : null;
            const auditRankPrev = auditMatch ? auditMatch[3] : null;

            const win1_10 = parseIntSafe($(mainCells[7]).text().trim());
            const win2_10 = parseIntSafe($(mainCells[8]).text().trim());
            const win3_10 = parseIntSafe($(mainCells[9]).text().trim());
            const out_10 = parseIntSafe($(mainCells[10]).text().trim());

            const avgTrialTimeStr = $(mainCells[11]).text().trim();
            const avgTrialTime = avgTrialTimeStr === '-' ? null : parseFloatSafe(avgTrialTimeStr);

            const rate90_2 = parseFloatSafe($(mainCells[14]).text().trim());
            const rate90_3 = parseFloatSafe($(mainCells[15]).text().trim());
            const rateGood_2 = parseFloatSafe($(mainCells[16]).text().trim());
            const rateGood_3 = parseFloatSafe($(mainCells[17]).text().trim());
            const rateWet_2 = parseFloatSafe($(mainCells[18]).text().trim());
            const rateWet_3 = parseFloatSafe($(mainCells[19]).text().trim());

            const prev10_stats = $(subCells[0]).text().trim().split('-').map(s => parseIntSafe(s));
            const good_stats = $(subCells[1]).text().trim().split('-').map(s => parseIntSafe(s));
            const wet_stats = $(subCells[2]).text().trim().split('-').map(s => parseIntSafe(s));

            const recentRaceData = recentRacesByCarNum[carNum] || {};
            
            riders.push({
                carNum, name, period, age, base, handicap, st, trialTime, deviation,
                auditPoint, auditRankCurrent, auditRankPrev,
                win1_10, win2_10, win3_10, out_10, avgTrialTime,
                rate90_2, rate90_3, rateGood_2, rateGood_3, rateWet_2, rateWet_3,
                history: {
                    prev10: { w1: prev10_stats[0], w2: prev10_stats[1], w3: prev10_stats[2], out: prev10_stats[3] },
                    good: { w1: good_stats[0], w2: good_stats[1], w3: good_stats[2], out: good_stats[3] },
                    wet: { w1: wet_stats[0], w2: wet_stats[1], w3: wet_stats[2], out: wet_stats[3] },
                },
                ...recentRaceData,
            avgTrial: recentRaceData.avgTrial ?? avgTrialTime ?? null,
            });
        }

        return {
            venue,
            kaisaiId,
            day: parseInt(day, 10),
            raceNo: parseInt(raceNo, 10),
            condition,
            riders,
        };
    } catch (error) {
        return { error: error.message };
    }
}

(async () => {
    const [,, venue, kaisaiId, day, raceNo] = process.argv;
    if (venue && kaisaiId && day && raceNo) {
        const data = await scrapeRaceCard(venue, kaisaiId, day, raceNo);
        console.log(JSON.stringify(data, null, 2));
    }
})();

module.exports = { scrapeRaceData: scrapeRaceCard };