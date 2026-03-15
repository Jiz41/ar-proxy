        if ('recentRaces' in data) {
            res.json(data.recentRaces);
        } else {
            res.json(data);
        }