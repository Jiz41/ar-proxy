(function () {
  'use strict';

  // ━━━━━━━━━━━━━━━━━━━━━━
  // 会場コード → 地名変換テーブル
  // ━━━━━━━━━━━━━━━━━━━━━━
  const VENUE_TO_BASE = {
    kawaguchi : '川口',
    isesaki   : '伊勢崎',
    hamamatsu : '浜松',
    iizuka    : '飯塚',
    sanyo     : '山陽',
  };

  // ━━━━━━━━━━━━━━━━━━━━━━
  // 走路条件変換
  // ━━━━━━━━━━━━━━━━━━━━━━
  function getRoadCondition(conditionStr) {
    if (!conditionStr) return 'good';
    if (conditionStr.includes('湿')) return 'wet';
    if (conditionStr.includes('良')) return 'good';
    return 'rough';
  }

  // ━━━━━━━━━━━━━━━━━━━━━━
  // 直近レースから ST 標準偏差を算出（w10）
  // ━━━━━━━━━━━━━━━━━━━━━━
  function calcStStd(recentRaces) {
    const sts = (recentRaces || [])
      .map(r => r.startTiming ?? r.st ?? null)
      .filter(v => v !== null && v > 0);
    if (sts.length < 2) return 0.0;
    const m = sts.reduce((a, b) => a + b, 0) / sts.length;
    const variance = sts.reduce((a, v) => a + (v - m) ** 2, 0) / (sts.length - 1);
    return Math.sqrt(variance);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━
  // メイン変換関数
  // ━━━━━━━━━━━━━━━━━━━━━━
  function parseRaceData(apiJson) {
    const venueBase = VENUE_TO_BASE[apiJson.venue] ?? apiJson.venue;
    const roadCondition = getRoadCondition(apiJson.condition);

    const activeRiders = apiJson.riders.filter(r => !r.isScratched);

    const players = activeRiders.map(r => {
      const trialDev = window.ArRonde.calcTrialDeviation(r.trialTime, r.avgTrial);
      const homeFlag = r.base === venueBase ? 1 : 0;
      const rainFlag = window.ArRonde.calcRainFlag(
        r.rateWet_2 ?? 0,
        r.rateGood_2 ?? 0,
        r.dryAvgTrial ?? 0,
        r.wetAvgTrial ?? 0,
        r.wetRaceCount ?? 0
      );
      const stStd         = calcStStd(r.recentRaces);
      const changeVehicle = 0;  // レースカード段階では未確定
      const dayProg       = 0;  // day1比較は結果取得後に算出

      return {
        carNum        : r.carNum,
        name          : r.name,
        handicap      : r.handicap ?? 0,
        deviation     : r.deviation ?? 0,
        st            : r.st ?? 0,
        winRate       : r.rate90_3 ?? 0,
        trialDev,
        homeFlag,
        rainFlag,
        changeVehicle,
        dayProg,
        stStd,
        auditRank     : r.auditPoint ?? 0,
        // フォーム表示用フィールド
        trialTime    : r.trialTime ?? null,
        avgTrial     : r.avgTrial ?? null,
        avgST        : r.avgST ?? null,
        rateGood3    : r.rateGood_3 ?? null,
        rateWet3     : r.rateWet_3 ?? null,
        wetRaceCount : r.wetRaceCount ?? 0,
        // rainFlag再計算用パススルー（ar_main.js のフォーム経路で使用 v1.0.10）
        dryAvgTrial  : r.dryAvgTrial ?? 0,
        wetAvgTrial  : r.wetAvgTrial ?? 0,
        recentRaces  : r.recentRaces ?? [],
      };
    });

    return {
      venue        : apiJson.venue,
      kaisaiId     : apiJson.kaisaiId,
      day          : apiJson.day,
      raceNo       : apiJson.raceNo,
      roadCondition,
      players,
    };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━
  // window.ArAdapter に公開
  // ━━━━━━━━━━━━━━━━━━━━━━
  window.ArAdapter = {
    parseRaceData,
    getRoadCondition,
  };

})();
