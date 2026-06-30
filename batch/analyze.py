"""
RONDE 重みパラメータ推定スクリプト
output/*.jsonl から各因子の寄与度を算出し、w1〜w7 の推奨値を出力する。
外部ライブラリ不使用（Python stdlib only）。
"""

import json
import glob
import os
import math
import random
from datetime import date


# ---------------------------------------------------------------------------
# 行列演算（stdlib only）
# ---------------------------------------------------------------------------

def mat_transpose(A):
    """2次元リストの転置"""
    rows = len(A)
    cols = len(A[0])
    return [[A[r][c] for r in range(rows)] for c in range(cols)]


def mat_mul(A, B):
    """行列積 A @ B"""
    rows_A = len(A)
    cols_A = len(A[0])
    cols_B = len(B[0])
    C = [[0.0] * cols_B for _ in range(rows_A)]
    for i in range(rows_A):
        for k in range(cols_A):
            if A[i][k] == 0.0:
                continue
            for j in range(cols_B):
                C[i][j] += A[i][k] * B[k][j]
    return C


def mat_vec_mul(A, v):
    """行列 × ベクトル → ベクトル"""
    return [sum(A[i][j] * v[j] for j in range(len(v))) for i in range(len(A))]


def lu_decompose(A):
    """
    LU分解（Doolittle法）。
    正方行列 A を破壊的に L, U に分解する（in-place）。
    ピボット交換なし → 行列が非退化であることを前提。
    戻り値: (LU合成行列, ピボット配列)
    """
    n = len(A)
    LU = [row[:] for row in A]  # copy
    perm = list(range(n))

    for k in range(n):
        # 部分ピボット選択
        max_val = abs(LU[k][k])
        max_row = k
        for i in range(k + 1, n):
            if abs(LU[i][k]) > max_val:
                max_val = abs(LU[i][k])
                max_row = i
        if max_row != k:
            LU[k], LU[max_row] = LU[max_row], LU[k]
            perm[k], perm[max_row] = perm[max_row], perm[k]

        pivot = LU[k][k]
        if abs(pivot) < 1e-12:
            raise ValueError("行列が特異（または近特異）です。")

        for i in range(k + 1, n):
            factor = LU[i][k] / pivot
            LU[i][k] = factor
            for j in range(k + 1, n):
                LU[i][j] -= factor * LU[k][j]

    return LU, perm


def lu_solve(LU, perm, b):
    """LU分解済み行列で Ax = b を解く"""
    n = len(LU)
    # ピボットに合わせて b を並び替え
    pb = [0.0] * n
    for i in range(n):
        pb[i] = b[perm[i]]

    # 前進代入（Ly = pb）
    y = [0.0] * n
    for i in range(n):
        s = pb[i]
        for j in range(i):
            s -= LU[i][j] * y[j]
        y[i] = s

    # 後退代入（Ux = y）
    x = [0.0] * n
    for i in range(n - 1, -1, -1):
        s = y[i]
        for j in range(i + 1, n):
            s -= LU[i][j] * x[j]
        x[i] = s / LU[i][i]

    return x


def mat_inv(A):
    """正方行列の逆行列（LU分解利用）"""
    n = len(A)
    LU, perm = lu_decompose(A)
    inv = []
    for col in range(n):
        e = [1.0 if i == col else 0.0 for i in range(n)]
        x = lu_solve(LU, perm, e)
        inv.append(x)
    return mat_transpose(inv)


def ols_solve(X, y, ridge=1e-3):
    """
    Ridge正規方程式 β = (X^T X + λI)^{-1} X^T y を解く。
    near-zero variance 列（changeVehicle等）による特異行列を回避するため
    λ=1e-3 のデフォルトRidge罰則を使用する。
    X: list[list[float]]  (n x p)
    y: list[float]        (n,)
    戻り値: β list[float] (p,)
    """
    Xt = mat_transpose(X)
    # X^T X
    XtX_sq = mat_mul(Xt, X)  # (p x p)
    # Ridge: X^T X + λI
    p = len(XtX_sq)
    for i in range(p):
        XtX_sq[i][i] += ridge
    # X^T y
    Xty = mat_vec_mul(Xt, y)  # (p,)
    # β = (X^T X + λI)^{-1} X^T y
    XtX_inv = mat_inv(XtX_sq)
    beta = mat_vec_mul(XtX_inv, Xty)
    return beta


# ---------------------------------------------------------------------------
# 統計ユーティリティ（stdlib only）
# ---------------------------------------------------------------------------

def rank_list(values):
    """
    値リストに対して順位（1-based、同値は平均ランク）を返す。
    """
    n = len(values)
    indexed = sorted(enumerate(values), key=lambda x: x[1])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j < n - 1 and indexed[j + 1][1] == indexed[i][1]:
            j += 1
        avg_rank = (i + 1 + j + 1) / 2.0
        for k in range(i, j + 1):
            ranks[indexed[k][0]] = avg_rank
        i = j + 1
    return ranks


def pearson_corr(xs, ys):
    """Pearson相関係数"""
    n = len(xs)
    if n < 2:
        return 0.0
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    num = sum((xs[i] - mean_x) * (ys[i] - mean_y) for i in range(n))
    den_x = math.sqrt(sum((x - mean_x) ** 2 for x in xs))
    den_y = math.sqrt(sum((y - mean_y) ** 2 for y in ys))
    if den_x < 1e-12 or den_y < 1e-12:
        return 0.0
    return num / (den_x * den_y)


def spearman_corr(xs, ys):
    """Spearman順位相関係数"""
    return pearson_corr(rank_list(xs), rank_list(ys))


def mean(vals):
    if not vals:
        return float("nan")
    return sum(vals) / len(vals)


def rmse(preds, actuals):
    n = len(preds)
    if n == 0:
        return float("nan")
    return math.sqrt(sum((p - a) ** 2 for p, a in zip(preds, actuals)) / n)


# ---------------------------------------------------------------------------
# データ読み込み・前処理
# ---------------------------------------------------------------------------

def load_races(pattern="output/*.jsonl"):
    """
    output/*.jsonl を全件読み込み、レースリストを返す。
    各要素: dict with keys date, venue, kaisaiId, day, raceNo,
                        trackCondition, weather, temperature, humidity,
                        results (list of player dicts)
    """
    races = []
    files = sorted(glob.glob(pattern))
    for fpath in files:
        with open(fpath, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                # racecard_*.jsonl 等の results を持たないオブジェクトは除外
                # （race_key 衝突による重複スキップを防ぐ）
                if "results" not in obj:
                    continue
                races.append(obj)
    return races


def stdev(vals):
    """不偏標準偏差（n>=2のみ、それ以外は0.0）"""
    n = len(vals)
    if n < 2:
        return 0.0
    m = sum(vals) / n
    return math.sqrt(sum((v - m) ** 2 for v in vals) / (n - 1))


def build_day1_trial_map(races):
    """
    day=1 の試走タイムを {(kaisaiId, playerId): trialRecord} でマップ化。
    w9（車両劣化）の基準値として使用。
    """
    d1_map = {}
    for race in races:
        if race.get("day", 1) != 1:
            continue
        for r in race.get("results", []):
            pid = r.get("playerId", "")
            trial = r.get("trialRecord", 0)
            if pid and trial > 0:
                d1_map[(race["kaisaiId"], pid)] = trial
    return d1_map


def compute_player_st_stds(races):
    """
    選手ごとの startTiming 標準偏差を算出（w10 近似値）。
    全収集レースの ST を使う（/race recentRaces の代替）。
    """
    player_sts = {}
    for race in races:
        for r in race.get("results", []):
            pid = r.get("playerId", "")
            st = r.get("startTiming")
            if pid and st is not None and st > 0:
                player_sts.setdefault(pid, []).append(st)
    return {pid: stdev(vals) for pid, vals in player_sts.items()}


def build_player_stats(races):
    """
    全レースから選手ごとの試走T平均・雨天/良走路着順リストを構築する。
    戻り値:
        player_avg_trial: {playerId: float}   2レース以上の選手のみ
        player_wet_orders: {playerId: [order, ...]}
        player_dry_orders: {playerId: [order, ...]}
    """
    player_trials = {}
    player_wet_orders = {}
    player_dry_orders = {}

    for race in races:
        tc = race.get("trackCondition", "")
        is_wet = "湿" in tc
        for r in race.get("results", []):
            pid = r.get("playerId", "")
            order = r.get("order", 0)
            trial = r.get("trialRecord", 0)
            if not pid or order == 0 or trial == 0:
                continue
            player_trials.setdefault(pid, []).append(trial)
            if is_wet:
                player_wet_orders.setdefault(pid, []).append(order)
            else:
                player_dry_orders.setdefault(pid, []).append(order)

    player_avg_trial = {
        pid: sum(v) / len(v)
        for pid, v in player_trials.items()
        if len(v) >= 2
    }
    return player_avg_trial, player_wet_orders, player_dry_orders


def compute_player_rain_flags(player_wet_orders, player_dry_orders):
    """
    フォールバック用: 雨天3レース以上 かつ (良走路平均着順 − 湿走路平均着順) >= 0.5 → rainFlag=1
    sunnyOrder/rainyOrder が利用可能な場合はこちらは使われない。
    """
    flags = {}
    for pid in set(player_wet_orders) | set(player_dry_orders):
        wet = player_wet_orders.get(pid, [])
        dry = player_dry_orders.get(pid, [])
        if len(wet) < 3:
            flags[pid] = 0
            continue
        wet_avg = sum(wet) / len(wet)
        dry_avg = sum(dry) / len(dry) if dry else 4.5
        flags[pid] = 1 if (dry_avg - wet_avg) >= 0.5 else 0
    return flags


def rain_flag_from_orders(sunny_order, rainy_order):
    """
    sunnyOrder/rainyOrder から直接 rainFlag を計算する。
    rainyOrder < sunnyOrder（雨天の方が期待順位が高い）→ 1
    いずれかが 0（データなし）→ 0
    """
    if sunny_order > 0 and rainy_order > 0:
        return 1 if rainy_order < sunny_order else 0
    return 0


def load_racecard_map(output_dir):
    """
    racecard_wet.jsonl + racecard_good.jsonl を読み込み、
    (venue, kaisaiId, day, raceNo, carNum) -> {rate90_3, rateWet_3} のマップを返す
    """
    rc_map = {}
    for fname in ["racecard_wet.jsonl", "racecard_good.jsonl"]:
        fpath = os.path.join(output_dir, fname)
        if not os.path.exists(fpath):
            continue
        with open(fpath, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("error"):
                    continue
                key_base = (d["venue"], d["kaisaiId"], d["day"], d["raceNo"])
                for r in d.get("riders", []):
                    key = key_base + (r.get("carNum"),)
                    rc_map[key] = {
                        "rate90_3":  r.get("rate90_3") or 0,
                        "rateWet_3": r.get("rateWet_3") or 0,
                    }
    return rc_map


def build_observations(races, player_avg_trial=None, player_rain_flags=None,
                       day1_trial_map=None, player_st_stds=None,
                       racecard_map=None):
    """
    レースリストから選手観測の flat リストとレース単位の情報を生成する。

    戻り値:
        observations: list of dict
            race_key, order, hIndex, startTiming, recommendationPoint,
            homeFlag, trialDev, rainFlag, is_wet (レースレベル)
        race_groups: dict[race_key -> list[obs_idx]]
        excluded_count: int
        wet_race_count: int
        total_raw: int
    """
    if player_avg_trial is None:
        player_avg_trial = {}
    if player_rain_flags is None:
        player_rain_flags = {}
    if day1_trial_map is None:
        day1_trial_map = {}
    if player_st_stds is None:
        player_st_stds = {}
    if racecard_map is None:
        racecard_map = {}
    observations = []
    race_groups = {}
    excluded_count = 0
    wet_race_count = 0
    total_raw = 0

    seen_race_keys = set()

    for race in races:
        race_key = f"{race['kaisaiId']}_day{race.get('day',1)}_R{race['raceNo']}"

        # 重複レース（複数 jsonl ファイルに同一レースが存在する場合）をスキップ
        if race_key in seen_race_keys:
            total_raw += len(race.get("results", []))
            excluded_count += len(race.get("results", []))
            continue
        seen_race_keys.add(race_key)

        tc = race.get("trackCondition", "")
        is_wet = 1 if "湿" in tc else 0
        if is_wet:
            wet_race_count += 1

        results = race.get("results", [])

        # レース内z正規化用の統計（ハンデ・試走タイム）
        race_handicaps = [r.get("handicap", 0) for r in results if r.get("handicap")]
        race_trials    = [r.get("trialRecord", 0) for r in results if r.get("trialRecord")]
        h_mean = sum(race_handicaps) / len(race_handicaps) if race_handicaps else 0
        h_std  = stdev(race_handicaps) if len(race_handicaps) >= 2 else 1
        t_mean = sum(race_trials) / len(race_trials) if race_trials else 0
        t_std  = stdev(race_trials) if len(race_trials) >= 2 else 1

        valid = []
        for r in results:
            total_raw += 1
            order = r.get("order", 0)
            trial = r.get("trialRecord", 0)
            # フィルタ: DNF / 計測なし
            if order == 0 or trial == 0:
                excluded_count += 1
                continue
            pid = r.get("playerId", "")
            # hIndex（絶対値方式・ar_ronde.js統一）: -handicap - trialRecord*1000
            hIndex = -r.get("handicap", 0) - (trial * 1000)
            # w4: 走路条件に応じて rate90_3 / rateWet_3 を選択（racecard由来）
            rc_key = (race["venue"], race["kaisaiId"], race["day"],
                      race["raceNo"], r.get("carNum"))
            rc_data = racecard_map.get(rc_key, {})
            winRate = rc_data.get("rateWet_3", 0) if is_wet else rc_data.get("rate90_3", 0)
            if winRate == 0:
                winRate = rc_data.get("rate90_3", 0)
            avg_trial = player_avg_trial.get(pid, 0)
            trial_dev = (trial / avg_trial) if avg_trial > 0 else 1.0
            # sunnyOrder/rainyOrder が存在すればそちらを優先、なければ統計フォールバック
            sunny = r.get("sunnyOrder", 0)
            rainy = r.get("rainyOrder", 0)
            if sunny > 0 or rainy > 0:
                rain_flag = float(rain_flag_from_orders(sunny, rainy))
            else:
                rain_flag = float(player_rain_flags.get(pid, 0))

            # w8: 乗り換え車両補正
            change_vehicle = float(r.get("changeVehicle", 0))

            # w9: 車両劣化（day1基準の試走タイム差）
            day_num = race.get("day", 1)
            d1_trial = day1_trial_map.get((race["kaisaiId"], pid), 0)
            day_prog = (trial - d1_trial) if (day_num > 1 and d1_trial > 0) else 0.0

            # w10: ST標準偏差（再現性リスク）
            st_std = player_st_stds.get(pid, 0.0)

            valid.append({
                "race_key": race_key,
                "playerId": pid,
                "order": order,
                "hIndex": hIndex,
                "startTiming": r.get("startTiming", 0.0),
                "recommendationPoint": winRate,
                "homeFlag": float(r.get("homeFlag", 0)),
                "trialDev": trial_dev,
                "rainFlag": rain_flag,
                "changeVehicle": change_vehicle,
                "dayProg": day_prog,
                "stStd": st_std,
                "is_wet": is_wet,
            })

        # 1レース3名未満は除外
        if len(valid) < 3:
            excluded_count += len(valid)
            wet_race_count -= is_wet  # カウント取り消し
            continue

        start_idx = len(observations)
        for obs in valid:
            observations.append(obs)
        race_groups[race_key] = list(range(start_idx, start_idx + len(valid)))

    return observations, race_groups, excluded_count, wet_race_count, total_raw


# ---------------------------------------------------------------------------
# レース内 min-max 正規化
# ---------------------------------------------------------------------------

def normalize_within_races(observations, race_groups):
    """
    各因子をレース内で 0-1 に min-max 正規化する。
    hIndex: 大きいほど不利（絶対値）→ INVERT=True で反転し大きいほど有利に
    ST:     小さいほど有利 → 反転
    recPoint: 高いほど有利 → そのまま
    homeFlag: そのまま（0/1 なのでレース内正規化は無意味なので生値利用）

    各観測に norm_ プレフィックスでフィールドを追加（in-place）。
    """
    FACTORS = ["hIndex", "startTiming", "recommendationPoint", "trialDev", "dayProg", "stStd"]
    INVERT = {"hIndex": True, "startTiming": True, "recommendationPoint": False,
              "trialDev": True, "dayProg": True, "stStd": True}

    for idxs in race_groups.values():
        for factor in FACTORS:
            vals = [observations[i][factor] for i in idxs]
            mn = min(vals)
            mx = max(vals)
            rng = mx - mn
            for i in idxs:
                raw = observations[i][factor]
                if rng < 1e-12:
                    norm = 0.5
                else:
                    norm = (raw - mn) / rng
                if INVERT[factor]:
                    norm = 1.0 - norm
                observations[i][f"norm_{factor}"] = norm

    # バイナリ値はそのまま（レース内正規化不要）
    for obs in observations:
        obs["norm_homeFlag"]      = obs["homeFlag"]
        obs["norm_rainFlag"]      = obs["rainFlag"]
        obs["norm_changeVehicle"] = obs["changeVehicle"]


# ---------------------------------------------------------------------------
# Spearman 相関分析
# ---------------------------------------------------------------------------

def compute_spearman(observations):
    """
    各因子スコア vs order の Spearman 相関を計算する。
    戻り値: dict[factor_name -> corr]
    """
    factor_keys = [
        ("hIndex_score",     "norm_hIndex"),
        ("ST_score",         "norm_startTiming"),
        ("recPoint_score",   "norm_recommendationPoint"),
        ("homeFlag",         "norm_homeFlag"),
        ("trialDev_score",   "norm_trialDev"),
        ("rainFlag",         "norm_rainFlag"),
        ("changeVehicle",    "norm_changeVehicle"),
        ("dayProg_score",    "norm_dayProg"),
        ("stStd_score",      "norm_stStd"),
    ]
    orders = [obs["order"] for obs in observations]
    results = {}
    for label, key in factor_keys:
        vals = [obs[key] for obs in observations]
        corr = spearman_corr(vals, orders)
        results[label] = corr
    return results


# ---------------------------------------------------------------------------
# 重回帰（OLS）
# ---------------------------------------------------------------------------

FEATURE_KEYS = [
    "norm_hIndex",
    "norm_startTiming",
    "norm_recommendationPoint",
    "norm_homeFlag",
    "norm_trialDev",
    "norm_rainFlag",
    "norm_changeVehicle",
    "norm_dayProg",
    "norm_stStd",
]
FEATURE_LABELS = [
    "hIndex", "ST", "recPoint", "homeFlag", "trialDev",
    "rainFlag", "changeVehicle", "dayProg", "stStd",
]


def build_XY(observations):
    """観測リストから X (n x p), y (n,) を構築"""
    X = [[obs[k] for k in FEATURE_KEYS] for obs in observations]
    y = [obs["order"] for obs in observations]
    return X, y


def compute_ols(observations):
    """
    全データで OLS を解き、回帰係数を返す。
    戻り値: list[float] (p,) — FEATURE_LABELS の順
    """
    X, y = build_XY(observations)
    beta = ols_solve(X, y)
    return beta


def compute_holdout_rmse(observations, race_groups, holdout_ratio=0.2, seed=42):
    """
    ランダムに holdout_ratio のレースを test セットとし、
    残りで OLS を学習して test セットの RMSE を返す。
    """
    random.seed(seed)
    race_keys = list(race_groups.keys())
    n_holdout = max(1, int(len(race_keys) * holdout_ratio))
    holdout_keys = set(random.sample(race_keys, n_holdout))

    train_obs = [obs for obs in observations if obs["race_key"] not in holdout_keys]
    test_obs = [obs for obs in observations if obs["race_key"] in holdout_keys]

    if len(train_obs) < len(FEATURE_KEYS) + 1:
        return float("nan")

    X_train, y_train = build_XY(train_obs)
    beta = ols_solve(X_train, y_train)

    X_test, y_test = build_XY(test_obs)
    preds = [sum(X_test[i][j] * beta[j] for j in range(len(beta))) for i in range(len(X_test))]
    return rmse(preds, y_test)


# ---------------------------------------------------------------------------
# 重み変換
# ---------------------------------------------------------------------------

def beta_to_weights(beta):
    """
    回帰係数 β → RONDE 形式 weights（max=1.0 正規化）。
    beta は [hIndex, ST, recPoint, homeFlag, trialDev, rainFlag,
             changeVehicle, dayProg, stStd] の順。
    戻り値: [w1, w3, w4, w6, w5, w7, w8, w9, w10] の順
    """
    abs_beta = [abs(b) for b in beta]
    max_b = max(abs_beta) if max(abs_beta) > 1e-12 else 1.0
    normalized = [b / max_b for b in abs_beta]
    return normalized  # 0=w1,1=w3,2=w4,3=w6,4=w5,5=w7,6=w8,7=w9,8=w10


# ---------------------------------------------------------------------------
# 雨天レース分析
# ---------------------------------------------------------------------------

def analyze_wet(observations):
    """
    良走路 vs 湿走路での 1着選手の hIndex 平均を比較する。
    戻り値: (dry_mean, wet_mean, wet_count)
    """
    dry_hindex = []
    wet_hindex = []
    for obs in observations:
        if obs["order"] == 1:
            if obs["is_wet"] == 0:
                dry_hindex.append(obs["hIndex"])
            else:
                wet_hindex.append(obs["hIndex"])
    return mean(dry_hindex), mean(wet_hindex), len(wet_hindex)


# ---------------------------------------------------------------------------
# 出力フォーマット
# ---------------------------------------------------------------------------

def interpret_corr(corr, expected_sign="negative"):
    """相関係数の解釈文字列"""
    threshold_strong = 0.15
    threshold_weak = 0.05
    abs_c = abs(corr)
    sign_ok = (expected_sign == "negative" and corr < 0) or \
               (expected_sign == "positive" and corr > 0)
    if abs_c >= threshold_strong and sign_ok:
        return "有効"
    elif abs_c >= threshold_weak:
        return "弱"
    else:
        return "無効"


def print_results(
    obs_count, race_count, excluded_count, wet_race_count,
    spearman, beta, weights, holdout_rmse,
    dry_hindex_mean, wet_hindex_mean, wet_winner_count,
):
    print()
    print("=== RONDE 重みパラメータ推定結果 ===")
    print()

    print("[データ統計]")
    print(f"有効観測数: {obs_count}件 ({race_count}レース)")
    print(f"除外: {excluded_count}件 (DNF・失格等)")
    wet_pct = wet_race_count / race_count * 100 if race_count else 0
    print(f"雨天レース: {wet_race_count}件 ({wet_pct:.1f}%)")
    print()

    print("[Spearman順位相関 vs 着順（order）]")
    print(f"{'因子':<20} {'相関係数':>10}   {'解釈'}")
    print("-" * 50)

    factor_rows = [
        ("hIndex_score",   spearman["hIndex_score"],   "negative", "ハンデ-試走が低いほど上位"),
        ("ST_score",       spearman["ST_score"],        "negative", "STが低いほど上位"),
        ("recPoint_score", spearman["recPoint_score"],  "negative", "審査Pが高いほど上位"),
        ("homeFlag",       spearman["homeFlag"],        "negative", "地元有利"),
        ("trialDev_score", spearman["trialDev_score"],  "negative", "試走乖離が低いほど上位"),
        ("rainFlag",       spearman["rainFlag"],        "negative", "雨強選手が上位"),
        ("changeVehicle",  spearman["changeVehicle"],   "negative", "乗り換え車両が不利"),
        ("dayProg_score",  spearman["dayProg_score"],   "negative", "車両劣化が小さいほど上位"),
        ("stStd_score",    spearman["stStd_score"],     "negative", "STばらつきが小さいほど上位"),
    ]
    for label, corr, exp_sign, note in factor_rows:
        interp = interpret_corr(corr, exp_sign)
        print(f"  {label:<18} {corr:>+8.3f}   {interp}（{note}）")
    print()

    print("[重回帰係数（OLS、レース内正規化済み）]")
    for label, b in zip(FEATURE_LABELS, beta):
        print(f"  {label:<12}: {b:>+8.4f}")
    print(f"  Holdout RMSE: {holdout_rmse:.3f}（参考値）")
    print()

    w1, w3, w4, w6, w5, w7, w8, w9, w10 = weights
    print("[RONDE形式の推奨weights]")
    print(f"  w1  (hIndex):         {w1:.2f}")
    print(f"  w3  (ST):             {w3:.2f}")
    print(f"  w4  (recPoint):       {w4:.2f}")
    print(f"  w5  (trialDev):       {w5:.2f}")
    print(f"  w6  (homeFlag):       {w6:.2f}")
    print(f"  w7  (rainFlag):       {w7:.2f}  （雨天{wet_race_count}件）")
    print(f"  w8  (changeVehicle):  {w8:.2f}")
    print(f"  w9  (dayProg):        {w9:.2f}")
    print(f"  w10 (stStd):          {w10:.2f}")
    print(f"  w2: 廃止（w5に一本化）")
    print()

    print("[雨天レース傾向]")
    if math.isnan(dry_hindex_mean):
        print("  良走路 1着選手のデータなし")
    else:
        print(f"  良走路での1着選手のhIndex平均: {dry_hindex_mean:.2f}")
    if math.isnan(wet_hindex_mean) or wet_winner_count == 0:
        print("  湿走路 1着選手のデータなし（サンプル不足）")
    else:
        print(f"  湿走路での1着選手のhIndex平均: {wet_hindex_mean:.2f}")
        if not math.isnan(dry_hindex_mean):
            diff = wet_hindex_mean - dry_hindex_mean
            tendency = "ある" if abs(diff) > 50 else "ない"
            direction = "ハンデ重視・試走T軽視" if diff > 0 else "試走T重視・ハンデ軽視"
            print(f"  → 湿路では{direction}の傾向が {tendency}")
    print()


def save_json(
    obs_count, race_count, spearman, beta, weights, holdout_rmse, out_path
):
    w1, w3, w4, w6, w5, w7, w8, w9, w10 = weights
    data = {
        "estimated_at": str(date.today()),
        "sample_count": obs_count,
        "race_count": race_count,
        "spearman": {
            "hIndex":        round(spearman["hIndex_score"], 4),
            "ST":            round(spearman["ST_score"], 4),
            "recPoint":      round(spearman["recPoint_score"], 4),
            "homeFlag":      round(spearman["homeFlag"], 4),
            "trialDev":      round(spearman["trialDev_score"], 4),
            "rainFlag":      round(spearman["rainFlag"], 4),
            "changeVehicle": round(spearman["changeVehicle"], 4),
            "dayProg":       round(spearman["dayProg_score"], 4),
            "stStd":         round(spearman["stStd_score"], 4),
        },
        "regression_coef": {
            "hIndex":        round(beta[0], 4),
            "ST":            round(beta[1], 4),
            "recPoint":      round(beta[2], 4),
            "homeFlag":      round(beta[3], 4),
            "trialDev":      round(beta[4], 4),
            "rainFlag":      round(beta[5], 4),
            "changeVehicle": round(beta[6], 4),
            "dayProg":       round(beta[7], 4),
            "stStd":         round(beta[8], 4),
        },
        "holdout_rmse": round(holdout_rmse, 4) if not math.isnan(holdout_rmse) else None,
        "recommended_weights": {
            "w1":  round(w1,  2),
            "w3":  round(w3,  2),
            "w4":  round(w4,  2),
            "w5":  round(w5,  2),
            "w6":  round(w6,  2),
            "w7":  round(w7,  2),
            "w8":  round(w8,  2),
            "w9":  round(w9,  2),
            "w10": round(w10, 2),
        },
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"[保存完了] {out_path}")


# ---------------------------------------------------------------------------
# メイン
# ---------------------------------------------------------------------------

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(script_dir)
    pattern = os.path.join(repo_root, "output", "*.jsonl")
    out_path = os.path.join(repo_root, "output", "weights_estimate.json")

    # 1. データ読み込み
    print("データ読み込み中…")
    races = load_races(pattern)
    if not races:
        print(f"[ERROR] {pattern} にデータが見つかりません。")
        return

    print(f"  読み込んだレース行数（生）: {len(races)}")

    # 2. 選手統計構築（試走T平均・雨天成績・ST標準偏差）
    player_avg_trial, player_wet_orders, player_dry_orders = build_player_stats(races)
    player_rain_flags = compute_player_rain_flags(player_wet_orders, player_dry_orders)
    day1_trial_map  = build_day1_trial_map(races)
    player_st_stds  = compute_player_st_stds(races)
    racecard_map    = load_racecard_map(os.path.join(repo_root, "output"))
    print(f"  racecardマップ: {len(racecard_map)}エントリ")
    rain_strong_count = sum(player_rain_flags.values())
    # sunnyOrder/rainyOrder の有無を確認
    sunny_available = sum(
        1 for race in races for r in race.get("results", [])
        if r.get("sunnyOrder", 0) > 0 or r.get("rainyOrder", 0) > 0
    )
    print(f"  選手数: 試走T平均={len(player_avg_trial)}名, 雨強={rain_strong_count}名, ST-std={len(player_st_stds)}名")
    print(f"  sunnyOrder/rainyOrder付きエントリ: {sunny_available}件")
    print(f"  day1試走マップ: {len(day1_trial_map)}エントリ")

    # 3. 前処理・フラット化
    observations, race_groups, excluded_count, wet_race_count, total_raw = build_observations(
        races, player_avg_trial, player_rain_flags,
        day1_trial_map=day1_trial_map, player_st_stds=player_st_stds,
        racecard_map=racecard_map
    )

    obs_count = len(observations)
    race_count = len(race_groups)

    if obs_count == 0:
        print("[ERROR] 有効な観測データがありません。")
        return

    print(f"  有効観測数: {obs_count}件 / {race_count}レース")

    # 4. レース内正規化
    normalize_within_races(observations, race_groups)

    # 5. Spearman 相関
    spearman = compute_spearman(observations)

    # 6. OLS 回帰
    beta = compute_ols(observations)

    # 7. Holdout RMSE
    holdout_rmse = compute_holdout_rmse(observations, race_groups)

    # 8. 重み変換
    weights = beta_to_weights(beta)

    # 9. 雨天分析
    dry_mean, wet_mean, wet_winner_count = analyze_wet(observations)

    # 10. 表示
    print_results(
        obs_count, race_count, excluded_count, wet_race_count,
        spearman, beta, weights, holdout_rmse,
        dry_mean, wet_mean, wet_winner_count,
    )

    # 11. JSON 保存
    save_json(obs_count, race_count, spearman, beta, weights, holdout_rmse, out_path)


if __name__ == "__main__":
    main()
