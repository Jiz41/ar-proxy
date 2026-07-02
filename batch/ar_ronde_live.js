(function() {
  'use strict';

  // ━━━━━━━━━━━━━━━━━━━━━━
  // TASK 2：当日試走乖離率
  // ━━━━━━━━━━━━━━━━━━━━━━
  function calcTrialDeviation(todayTrial, avgTrial) {
    // todayTrial : 当日試走タイム
    // avgTrial   : 過去平均試走タイム
    // return     : 乖離率（1.0未満が仕上がり）
    // ※ avgTrialが0またはnullの場合は1.0を返す（安全処理）
    return avgTrial > 0 ? todayTrial / avgTrial : 1.0;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━
  // TASK 3：雨強スコア → 雨強フラグ
  // ━━━━━━━━━━━━━━━━━━━━━━
  // RAIN_K: 秒→％pt換算係数。K=1.0では試走項（秒オーダー0.0x）が連対率項
  // （％オーダー数十）に埋没し事実上無視されていたため是正（v1.0.9）。
  // 2026-07-02 実データ125名（湿3走以上）のOLS傾き 85.3％pt/秒 に基づく実証値。
  // 注: (dryAvgTrial-wetAvgTrial) は平均-0.31秒（湿走路は系統的に遅い）のため、
  // K=85では約-26％ptのオフセットが乗り、フラグ判定は従来比で厳格化する
  // （雨強フラグ率 42.4%→15.2%）。
  const RAIN_K = 85;
  const RAIN_THETA = 0.0; // 閾値θ（据置。K実証化後の score>=0 は「湿適性が平均的減速ペナルティを上回る」の意）
  const RAIN_MIN_RACES = 3; // 湿走路最低出走数（analyze.py に合わせて3以上）

  function calcRainScore(wetRate, dryRate, dryAvgTrial, wetAvgTrial) {
    // wetRate     : 湿走路2連対率（%）
    // dryRate     : 良走路2連対率（%）
    // dryAvgTrial : 良走路試走T平均
    // wetAvgTrial : 湿走路試走T平均
    return (wetRate - dryRate) + (dryAvgTrial - wetAvgTrial) * RAIN_K;
  }

  function calcRainFlag(wetRate, dryRate, dryAvgTrial, wetAvgTrial, wetRaceCount) {
    // wetRaceCount : 湿走路出走数
    // return       : 1（雨強）または 0
    if (wetRaceCount < RAIN_MIN_RACES) return 0;
    const score = calcRainScore(wetRate, dryRate, dryAvgTrial, wetAvgTrial);
    return score >= RAIN_THETA ? 1 : 0;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━
  // TASK 4：総合スコア
  // ━━━━━━━━━━━━━━━━━━━━━━
  // 重み（1499レース/10794obs 実測推定値 2026-06-30）
  const WEIGHTS = {
    w1:0.18, w2:1.00, w3:0.16, w4:0.33,
    w5:0.12, w6:0.18, w7:0.02,
    w8:0.01, w9:0.02,
  };
  // 走路係数初期値
  // 【未使用】現行の calcRaceScores では適用していない（analyze.py に対応物が無いため）。
  // 互換性のため公開APIには残置しているが、スコア計算には一切影響しない。
  const ROAD_COEF = { good:1.0, wet:1.0, rough:1.0 };

  // [LEGACY - 削除済み] calcTotalScore
  // v1.0.7以降はcalcRaceScoresに移行済み。
  // 旧設計：hIndex単一合成指数×重みの素朴な加算方式（正規化なし）
  // 廃止理由：レース内min-max正規化導入によりcalcRaceScoresに置換。

  // ━━━━━━━━━━━━━━━━━━━━━━
  // TASK 4b：レース内正規化スコア（analyze.py の normalize_within_races 対応）
  // ━━━━━━━━━━━━━━━━━━━━━━
  function calcRaceScores(players, roadCondition) {
    // analyze.py 同様、レース内で各連続因子を min-max 正規化 [0,1] してから
    // OLS推定重み WEIGHTS を掛けて totalScore を算出する。
    // バイナリ値（homeFlag/rainFlag）は正規化せず生値を使う。
    // ROAD_COEF は analyze.py に対応物が無いため適用しない。

    // w4対象値（recPoint）の決定：wet時は全員 rateWet3（欠測は0扱い）、良走路は winRate。
    // rateWet3===0 で winRate にフォールバックする方式は、意味の異なる指標が
    // 同一列で混在正規化される不具合のため廃止（v1.0.9）
    const recPoints = players.map(p =>
      roadCondition === 'wet' ? (p.rateWet3 ?? 0) : p.winRate
    );

    // レース内 min-max 正規化（analyze.py のロジック準拠）
    // 欠測（null/undefined/NaN）は min/max 計算から除外し、norm=0.5（レース内
    // 中央相当）を割り当てる。rng≈0 のとき 0.5 とする既存思想と一貫（v1.0.9）。
    // INVERT列で欠測を 0 扱いすると「欠測者が最良評価」になる不具合の是正。
    function normalizeColumn(vals, invert) {
      const isMissing = v => v == null || Number.isNaN(v);
      const valid = vals.filter(v => !isMissing(v));
      const mn = Math.min(...valid);
      const mx = Math.max(...valid);
      const rng = mx - mn;
      return vals.map(raw => {
        if (isMissing(raw)) return 0.5;
        let norm;
        if (rng < 1e-12) {
          norm = 0.5;
        } else {
          norm = (raw - mn) / rng;
        }
        if (invert) norm = 1.0 - norm;
        return norm;
      });
    }

    // 各因子の正規化（INVERT方向は analyze.py の FACTORS/INVERT と一致）
    // 欠測は null に落とし normalizeColumn 側で norm=0.5 に統一する（v1.0.9）
    // handicap: INVERT=False（重いほど有利・実力の代理）。0mは正当値のため ?? 0 を維持
    const normHandicap    = normalizeColumn(players.map(p => p.handicap ?? 0), false);
    // trialRecord: INVERT=True（小さいほど速い=有利）。0以下は試走未実施＝欠測
    const normTrialRecord = normalizeColumn(players.map(p => (p.trialTime > 0 ? p.trialTime : null)), true);
    const normSt       = normalizeColumn(players.map(p => p.st ?? null),    true);
    const normRecPoint = normalizeColumn(recPoints,                        false);
    // trialDev: 比率（>0が正当値）。欠測試走由来の 0 も欠測扱い
    const normTrialDev = normalizeColumn(players.map(p => (p.trialDev > 0 ? p.trialDev : null)), true);
    const normDayProg  = normalizeColumn(players.map(p => p.dayProg ?? null), true);
    const normStStd    = normalizeColumn(players.map(p => p.stStd ?? null),  true);

    return players.map((p, i) => {
      const totalScore =
        normHandicap[i]    * WEIGHTS.w1 +
        normTrialRecord[i] * WEIGHTS.w2 +
        normSt[i]       * WEIGHTS.w3 +
        normRecPoint[i] * WEIGHTS.w4 +
        normTrialDev[i] * WEIGHTS.w5 +
        (p.homeFlag ?? 0)       * WEIGHTS.w6 +
        // rainFlag は湿走路レース限定で加算（良走路での無意味な常時加点を廃止 v1.0.9）
        (roadCondition === 'wet' ? (p.rainFlag ?? 0) : 0) * WEIGHTS.w7 +
        normDayProg[i]  * WEIGHTS.w8 +
        normStStd[i]    * WEIGHTS.w9;

      return { ...p, totalScore };
    });
  }

  // ━━━━━━━━━━━━━━━━━━━━━━
  // TASK 5：荒れ度計算
  // ━━━━━━━━━━━━━━━━━━━━━━
  // 予想適正★1〜10の境界値（バックテスト1331レースのscoreStd等頻度10分位 v1.0.12）
  // 昇順。★kは std >= STAR_BOUNDS[k-1] かつ < STAR_BOUNDS[k]。
  // ★1は観測最小値(0.2661)未満もopen扱い（下限なし）、★10は上限なし。
  const STAR_BOUNDS = [0.2661, 0.3898, 0.4156, 0.4363, 0.4512,
                       0.4671, 0.4857, 0.5004, 0.5214, 0.5489];

  function calcVolatility(players) {
    // players : calcRaceScoresを適用済みの選手配列（totalScore必須）
    // return  : { score: 標準偏差, label: '高'|'中'|'低', star: 1〜10 }
    // ※ 旧hIndex（廃止済み）参照を totalScore に変更（v1.0.9）
    const scores = players.map(p => p.totalScore);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    const std = Math.sqrt(variance);
    // 閾値はバックテスト1331レース（racecard×results突合・試走完備）の
    // レース内std三分位 0.443 / 0.495 に再校正（v1.0.11）。
    // 旧値0.15/0.20は試走前データ（w2列圧縮）への過適合だった。
    // stdが小さい=実力接近=荒れ「高」（判定方向は従来踏襲）
    const label = std < 0.443 ? '高' : std < 0.495 ? '中' : '低';
    // 予想適正★: stdが大きい=格差明瞭=モデル得意条件（★10）、小さい=接戦=不得手（★1）
    let star = 1;
    for (let i = STAR_BOUNDS.length - 1; i >= 1; i--) {
      if (std >= STAR_BOUNDS[i]) { star = i + 1; break; }
    }
    return { score: std, label, star };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━
  // TASK 6：特異点L検出
  // ━━━━━━━━━━━━━━━━━━━━━━
  function calcLPoint(players) {
    // ハンデ昇順でソートしてランクをMapに記録（副作用なし）
    // 同ハンデは同順位（競技順位方式: 0,0,10 → 1,1,3）。ソート順の揺れで
    // L判定（±2）の境界が変動するのを防ぐ（v1.0.9）
    const sorted = [...players].sort((a, b) => a.handicap - b.handicap);
    const handicapRankMap = new Map();
    sorted.forEach((p, i) => {
      const rank = (i > 0 && p.handicap === sorted[i - 1].handicap)
        ? handicapRankMap.get(sorted[i - 1].carNum)
        : i + 1;
      handicapRankMap.set(p.carNum, rank);
    });

    return players.map(p => {
      const handicapRank = handicapRankMap.get(p.carNum);
      const lScore = p.auditRank - handicapRank;
      const lFlag = lScore >= 2 ? 'L+' : lScore <= -2 ? 'L-' : null;
      return { ...p, handicapRank, lScore, lFlag };
    });
  }

  // ━━━━━━━━━━━━━━━━━━━━━━
  // TASK 7：買い目生成
  // ━━━━━━━━━━━━━━━━━━━━━━
  function generateBets(players) {
    // 8点構成（v1.0.12、バックテスト1331レース実測25.5%の頻度上位8順列）
    // A/B/C/D = totalScore降順の1〜4位。
    //   構成: ACB, ABC, BAC, BCA, ABD, BAD, CBA, ACD
    //   推奨1点: ACB（8点中の最高実現率5.2%）
    // 表示記法:
    //   ABC/ACB/BAC/BCA → フォーメーション「AB-ABC-ABC」（推奨1点ACBを含む4点）
    //   ABD/BAD         → フォーメーション「AB-AB-D」（2点）
    //   CBA / ACD       → 単品表記（各1点）
    if (players.length < 3) {
      return { recommend: '', eight: [], display: [], note: `出走${players.length}名のため買い目生成不可` };
    }
    const ranked = [...players].sort((a, b) => b.totalScore - a.totalScore);
    const A = ranked[0].carNum;
    const B = ranked[1].carNum;
    const C = ranked[2].carNum;
    const D = ranked.length >= 4 ? ranked[3].carNum : null;

    // 推奨1点: ACB
    const recommend = `${A}-${C}-${B}`;

    // 8点の個別列挙（的中判定・検証用）
    const eight = [
      `${A}-${C}-${B}`,  // ACB（推奨）
      `${A}-${B}-${C}`,  // ABC
      `${B}-${A}-${C}`,  // BAC
      `${B}-${C}-${A}`,  // BCA
      `${C}-${B}-${A}`,  // CBA
    ];
    if (D != null) {
      eight.push(
        `${A}-${B}-${D}`,  // ABD
        `${B}-${A}-${D}`,  // BAD
        `${A}-${C}-${D}`   // ACD
      );
    }

    // 位置内は車番昇順で連結（フォーメーション慣例表記）
    const pos = arr => [...arr].sort((a, b) => a - b).join('');

    const display = [
      {
        label: 'フォーメーション（推奨1点を含む4点）',
        value: `${pos([A, B])}-${pos([A, B, C])}-${pos([A, B, C])}`,
        count: 4,
        includesRecommend: true,
      },
    ];
    if (D != null) {
      display.push(
        { label: 'フォーメーション（2点）', value: `${pos([A, B])}-${pos([A, B])}-${D}`, count: 2, includesRecommend: false },
        { label: '単品', value: `${C}-${B}-${A}`, count: 1, includesRecommend: false },
        { label: '単品', value: `${A}-${C}-${D}`, count: 1, includesRecommend: false }
      );
    } else {
      display.push(
        { label: '単品', value: `${C}-${B}-${A}`, count: 1, includesRecommend: false }
      );
    }

    const note = D == null ? '出走3名のためD絡み3点（ABD/BAD/ACD）を除外した5点構成' : undefined;
    return note ? { recommend, eight, display, note } : { recommend, eight, display };
  }


  // ━━━━━━━━━━━━━━━━━━━━━━
  // TASK 8：展開シナリオ生成
  // ━━━━━━━━━━━━━━━━━━━━━━
  function generateScenario(players, laps) {
    laps = laps || 6;
    var n = players.length;
    if (n === 0) return { lapTable: [], playerTypes: {} };

    // 1. スタート順位（ハンデ昇順）
    // 同ハンデはST昇順（好スタート順）でタイブレーク（v1.0.13）。
    // 実際の発走では同ハンデは横並びで、隊列はSTで決まるため
    // （従来の配列順=根拠なしを廃止。calcLPointの同ハンデタイ扱いと同思想）。
    // ST欠測（0以下）は最後尾扱い、最後はcarNum昇順で決定的にする。
    var byHandicap = players.slice().sort(function(a, b) {
      if (a.handicap !== b.handicap) return a.handicap - b.handicap;
      var sa = (a.st > 0) ? a.st : Infinity;
      var sb = (b.st > 0) ? b.st : Infinity;
      if (sa !== sb) return sa - sb;
      return a.carNum - b.carNum;
    });
    var startRankMap = {};
    byHandicap.forEach(function(p, i) { startRankMap[p.carNum] = i + 1; });

    // 2. ゴール順位（totalScore降順 = 既存予想と整合）
    var byScore = players.slice().sort(function(a, b) { return b.totalScore - a.totalScore; });
    var finishRankMap = {};
    byScore.forEach(function(p, i) { finishRankMap[p.carNum] = i + 1; });

    // 因子寸評（v1.0.14）: 既存因子 stStd/trialDev/dayProg/homeFlag を
    // 型別の優先順位で評価し、該当する語句を最大2つ返す（表示専用）。
    // 閾値は収集データの四分位に基づく実測値:
    //   stStd    : 安定 <=0.043 / 不安定 >=0.067（n=10888, q25/q75）
    //   trialDev : 仕上がり良 <=0.983 / 不安 >=1.044（n=10763, q25/q75）
    //   dayProg  : 上向き <=-0.04 / 陰り >=+0.02（n=7039, q25/q75。0=未計測は対象外）
    function factorNotes(p, type) {
      var stG  = p.stStd > 0 && p.stStd <= 0.043;
      var stB  = p.stStd >= 0.067;
      var trG  = p.trialDev > 0 && p.trialDev <= 0.983;
      var trB  = p.trialDev >= 1.044;
      var dpU  = p.dayProg <= -0.04;
      var dpD  = p.dayProg >= 0.02;
      var home = (p.homeFlag ?? 0) === 1;
      var cand;
      if (type === 'senkou') {
        cand = [
          [stG,  'ST安定で主導権を握る算段'],
          [stB,  'ST不安定なら展開暗転も'],
          [trG,  '試走良く仕上がり十分'],
          [trB,  '試走一息で仕上がりに不安'],
          [dpU,  '初日より試走短縮で車は上向き'],
          [dpD,  '初日より試走落ちで車に陰り'],
          [home, '地元走路を熟知'],
        ];
      } else if (type === 'makuri') {
        cand = [
          [trG,  '試走良く仕上がり十分'],
          [trB,  '試走一息で仕上がりに不安'],
          [dpU,  '初日より試走短縮で車は上向き'],
          [dpD,  '初日より試走落ちで車に陰り'],
          [stB,  'ST不安定で序盤置かれる懸念'],
          [stG,  'ST安定で仕掛けは早め'],
          [home, '地元走路を熟知'],
        ];
      } else if (type === 'shissoku') {
        cand = [
          [trB,  '試走一息で仕上がりにも不安'],
          [dpD,  '初日より試走落ちで車に陰り'],
          [stB,  'ST不安定で序盤から苦しい'],
          [home, '地元の粘りに期待'],
          [trG,  '試走は良く粘り込みなら'],
          [dpU,  '初日より試走短縮で車は上向き'],
        ];
      } else {
        cand = [
          [home, '地元走路を熟知'],
          [stG,  'ST安定で立ち回り堅実'],
          [stB,  'ST不安定が波乱要素'],
          [trG,  '試走良く仕上がり十分'],
          [trB,  '試走一息で仕上がりに不安'],
          [dpU,  '初日より試走短縮で車は上向き'],
          [dpD,  '初日より試走落ちで車に陰り'],
        ];
      }
      var notes = [];
      for (var ci = 0; ci < cand.length && notes.length < 2; ci++) {
        if (cand[ci][0]) notes.push(cand[ci][1]);
      }
      return notes;
    }

    // 3. 軌跡タイプ分類
    var playerTypes = {};
    players.forEach(function(p) {
      var sr = startRankMap[p.carNum];
      var fr = finishRankMap[p.carNum];
      var delta = sr - fr;
      var type, label, reason;

      if (sr <= 2 && delta >= 0) {
        type = 'senkou'; label = '先行型';
        reason = '前方スタートから逃げ切り';
      } else if (delta >= 2) {
        type = 'makuri'; label = '捲り型';
        var recC = Math.abs((p.winRate || 0) * WEIGHTS.w4);
        var triC = Math.abs((1 - (p.trialDev || 1)) * WEIGHTS.w5);
        reason = recC >= triC ? '審査P・実績で後半追い上げ' : '当日仕上がりで後半追い上げ';
      } else if (delta <= -2) {
        // 失速・飲み込まれ型（v1.0.13新設）: 従来は安定型に混入していた
        // 「2順位以上の後退予測」を独立させる（ハンデ戦の最頻出展開）
        type = 'shissoku'; label = '失速型';
        reason = sr <= 2
          ? '前方スタートも押し切れず終盤に飲み込まれる'
          : '中盤まで位置を保つも終盤に後続へ飲み込まれる';
      } else {
        // 安定型は |delta|<=1 のみ（残余バケツから純化 v1.0.13）
        type = 'stable'; label = '安定型';
        if (delta >= 0) reason = '安定した走行で位置を維持';
        else            reason = 'ほぼ位置を保つも小幅後退';
      }

      // 因子寸評を型別優先順位で最大2句追記（v1.0.14）
      var fn = factorNotes(p, type);
      if (fn.length > 0) reason += '。' + fn.join('、');

      playerTypes[p.carNum] = {
        type: type, label: label, reason: reason,
        startRank: sr, finishRank: fr, delta: delta,
      };
    });

    // 4. タイプ別ウェイポイント（lap 1〜6 の進捗率）
    //    進捗率 progress → 目標位置 = sr + (fr - sr) * progress
    var WAYPOINTS = {
      senkou:   [0.60, 0.75, 0.80, 0.85, 0.90, 1.0],
      makuri:   [0.05, 0.10, 0.20, 0.55, 0.80, 1.0],
      stable:   [0.15, 0.30, 0.45, 0.60, 0.80, 1.0],
      // 失速型: 中盤まで前方（スタート位置付近）を維持し、終盤に急落して
      // 予想着順へ沈む軌跡（v1.0.13）
      shissoku: [0.05, 0.10, 0.15, 0.30, 0.70, 1.0],
    };

    // 当該タイプ・当該周回の進捗率を返す。
    // laps が 6 の場合はウェイポイントを直接使用。
    // 6 以外の場合は (k/6, wp[k-1])（始点 (0,0)）の折れ線を線形補間して写像する。
    function progressFor(type, lap) {
      var wp = WAYPOINTS[type] || WAYPOINTS.stable;
      if (lap >= laps) return 1.0;
      if (laps === 6) return wp[lap - 1];
      var u = lap / laps;
      var pts = [{ x: 0, y: 0 }];
      for (var k = 1; k <= 6; k++) pts.push({ x: k / 6, y: wp[k - 1] });
      for (var i = 1; i < pts.length; i++) {
        if (u <= pts[i].x) {
          var x0 = pts[i - 1].x, y0 = pts[i - 1].y;
          var x1 = pts[i].x, y1 = pts[i].y;
          var r = (x1 === x0) ? 0 : (u - x0) / (x1 - x0);
          return y0 + (y1 - y0) * r;
        }
      }
      return 1.0;
    }

    // 5. 周回テーブル構築（各周回で順位を直接設計）
    // lapTable[lap] = [1位のcarNum, 2位のcarNum, ...]
    var lapTable = [];

    // lap 0: ハンデ順（スタート位置）
    lapTable.push(byHandicap.map(function(p) { return p.carNum; }));

    // 直前周回の整数順位（lap 0 はスタート順位）
    var prevRankMap = {};
    Object.keys(startRankMap).forEach(function(cn) {
      prevRankMap[cn] = startRankMap[cn];
    });

    for (var lap = 1; lap <= laps; lap++) {
      // 1周あたりの最大移動幅（lap 1 はスタートラッシュで ±4、以降 ±3）
      var baseMove = (lap === 1) ? 4 : 3;
      // 当該周を含む残り周回数
      var remainingLaps = laps - lap + 1;

      var slots = players.map(function(p) {
        var sr = startRankMap[p.carNum];
        var fr = finishRankMap[p.carNum];
        var prev = prevRankMap[p.carNum];

        // 目標浮動小数位置
        var target = sr + (fr - sr) * progressFor(playerTypes[p.carNum].type, lap);

        // クランプ緩和: 残り周回で fr に到達できるよう最大移動幅を確保する。
        // 例) 残り2周で3位差 → ceil(3/2)=2 ≤ ±3 で据置、
        //     残り1周で4位差 → ceil(4/1)=4 > ±3 のため ±4 に緩和。
        var needed = Math.ceil(Math.abs(fr - prev) / remainingLaps);
        var maxMove = Math.max(baseMove, needed);

        var lo = prev - maxMove;
        var hi = prev + maxMove;
        var pos = target < lo ? lo : (target > hi ? hi : target);

        return { carNum: p.carNum, pos: pos, fr: fr };
      });

      // 昇順ソート→整数順位割当（衝突解決）。
      // タイbreaking: ゴール順位（fr）が上位（小さい）方を上位に。
      // なお同 fr は carNum 昇順で安定化。
      slots.sort(function(a, b) {
        if (a.pos !== b.pos) return a.pos - b.pos;
        if (a.fr !== b.fr) return a.fr - b.fr;
        return a.carNum - b.carNum;
      });

      lapTable.push(slots.map(function(s) { return s.carNum; }));
      slots.forEach(function(s, i) { prevRankMap[s.carNum] = i + 1; });
    }

    // 最終周を既存予想順位に強制整合
    // 【仕様】途中周回のクランプ計算と最終周が不連続になり得るが、
    // 「最終順位＝totalScore予想と必ず一致」を優先する意図的な設計である。
    lapTable[laps] = byScore.map(function(p) { return p.carNum; });

    return { lapTable: lapTable, playerTypes: playerTypes };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━
  // IIFEラッパーで全体を囲み window.ArRonde に公開すること
  // ━━━━━━━━━━━━━━━━━━━━━━
  window.ArRonde = {
    calcTrialDeviation,
    calcRainFlag,
    calcRaceScores,
    calcVolatility,
    calcLPoint,
    generateBets,
    generateScenario,
    WEIGHTS,
    ROAD_COEF,  // 【未使用】スコア計算には不適用（互換性のための残置）

    RAIN_K,
    RAIN_THETA,
  };

})();