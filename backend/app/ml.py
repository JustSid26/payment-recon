"""Lightweight ML layer over the transaction book, powering the Insights page.

Deliberately trains on the transaction *mix* only — card brand, issuing bank,
amount band, currency and time-of-day — and NOT the country. That way the model
predicts the approval rate you'd *expect* from a country's mix; the gap between
that and the actual rate is the country-specific signal that drives the anomaly
flags and the "what's driving declines here" breakdown.

Everything is computed on demand and cached by (scope, row-count) so a fresh
upload transparently invalidates it. This is a static demo dataset, so treat the
numbers as illustrative of the capability.
"""
from __future__ import annotations

import numpy as np
from sklearn.cluster import KMeans
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import OneHotEncoder, StandardScaler

APPROVED = ("captured", "refunded", "partially_refunded")
MIX_GROUPS = ["brand", "issuer", "amount", "time"]
GROUP_LABEL = {
    "brand": "Card-brand mix", "issuer": "Issuing-bank mix",
    "amount": "Ticket size", "time": "Time of day",
    "country": "Country-specific",
}
_MIN_SEGMENT = 40      # min decided txns for a country to be scored/clustered
_TOP_ISSUERS = 25      # keep the busiest issuers, bucket the rest as OTHER

_cache: dict = {}


def country_case(col: str = "country") -> str:
    """SQL expression normalising a raw country field to an ISO-2 code: uppercases
    2-letter codes, maps the common full-name spellings the processors send, and
    buckets anything blank/unrecognised as '??'. Shared by the Insights queries so
    the same row always lands in the same country everywhere."""
    x = f"UPPER(BTRIM(COALESCE({col},'')))"
    return (
        f"CASE WHEN {x} IN ('US','USA','UNITED STATES') THEN 'US' "
        f"WHEN {x} IN ('GB','UK','UNITED KINGDOM') THEN 'GB' "
        f"WHEN {x} = 'BELGIUM' THEN 'BE' "
        f"WHEN LENGTH({x}) = 2 THEN {x} "
        f"ELSE '??' END"
    )


def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


def _amount_bands(amount: np.ndarray, ccy: np.ndarray) -> np.ndarray:
    """Quartile band within each currency, so €50 and ¥5000 aren't compared on a
    raw scale. Returns labels S/M/L/XL."""
    out = np.empty(amount.shape, dtype=object)
    out[:] = "M"
    for c in np.unique(ccy):
        m = ccy == c
        vals = amount[m]
        qs = np.quantile(vals, [0.25, 0.5, 0.75]) if vals.size else [0, 0, 0]
        lab = np.where(vals <= qs[0], "S", np.where(vals <= qs[1], "M", np.where(vals <= qs[2], "L", "XL")))
        out[m] = lab
    return out


def compute(cur, mid: int | None, currency: str | None) -> dict:
    p = {"mid": mid, "ccy": currency.upper() if currency else None}
    filt = ""
    if mid:
        filt += " AND merchant_id = %(mid)s"
    if currency:
        filt += " AND currency = %(ccy)s"

    # cache key: scope + a cheap data fingerprint (row count)
    cur.execute(f"SELECT COUNT(*) n FROM transactions WHERE status = ANY(%(dec)s) {filt}",
                {**p, "dec": [*APPROVED, "auth_failed"]})
    n = cur.fetchone()["n"]
    key = (mid, currency, n)
    if key in _cache:
        return _cache[key]
    if n < 200:
        return {"available": False, "reason": "Not enough decided transactions to model yet."}

    cur.execute(f"""
        SELECT {country_case()} country,
               COALESCE(NULLIF(payment_brand,''),'—') brand,
               COALESCE(NULLIF(issuing_bank,''),'—') issuer,
               currency,
               GREATEST(auth_minor, captured_minor) amount,
               EXTRACT(HOUR FROM occurred_at)::int hr,
               (status = ANY(%(dec)s))::int declined
          FROM transactions
         WHERE status = ANY(%(all)s) {filt}""",
                {**p, "dec": ["auth_failed"], "all": [*APPROVED, "auth_failed"]})
    rows = cur.fetchall()
    country = np.array([r["country"] for r in rows])
    brand = np.array([r["brand"] for r in rows])
    issuer_raw = np.array([r["issuer"] for r in rows])
    ccy = np.array([r["currency"] for r in rows])
    amount = np.array([float(r["amount"]) for r in rows])
    hour = np.array([r["hr"] for r in rows])
    y = np.array([r["declined"] for r in rows])          # 1 = declined

    # bucket rare issuers so the one-hot stays sane
    uiss, counts = np.unique(issuer_raw, return_counts=True)
    keep = set(uiss[np.argsort(-counts)[:_TOP_ISSUERS]])
    issuer = np.array([i if i in keep else "OTHER" for i in issuer_raw])
    amount_band = _amount_bands(amount, ccy)
    time_band = np.where(hour < 6, "night", np.where(hour < 12, "morning",
                         np.where(hour < 18, "afternoon", "evening")))

    cols = {"brand": brand, "issuer": issuer, "amount": amount_band, "time": time_band, "ccy": ccy}
    X_cat = np.column_stack([cols["brand"], cols["issuer"], cols["amount"], cols["time"], cols["ccy"]])
    enc = OneHotEncoder(handle_unknown="ignore", sparse_output=False).fit(X_cat)
    Xe = enc.transform(X_cat)
    names = enc.get_feature_names_out(["brand", "issuer", "amount", "time", "ccy"])
    group_cols = {g: np.array([i for i, nm in enumerate(names) if nm.startswith(g + "_")]) for g in
                  ["brand", "issuer", "amount", "time"]}

    clf = LogisticRegression(max_iter=2000, C=1.0)
    clf.fit(Xe, y)
    prob = clf.predict_proba(Xe)[:, 1]                    # P(decline) from mix
    try:
        auc = float(roc_auc_score(y, prob))
    except ValueError:
        auc = float("nan")
    w = clf.coef_[0]
    b = clf.intercept_[0]
    global_mean = Xe.mean(axis=0)
    base_decline = float(y.mean())

    def decline_of(vec):
        return float(_sigmoid(b + w @ vec))

    # ---- per-country: expected (mix) vs actual, and driver decomposition ----
    countries: dict = {}
    resid_list, vol_list, code_list = [], [], []
    for c in np.unique(country):
        m = country == c
        decided = int(m.sum())
        actual_decline = float(y[m].mean())
        mean_vec = Xe[m].mean(axis=0)
        expected_decline = float(prob[m].mean())
        drivers = []
        for g in MIX_GROUPS:
            gc = group_cols[g]
            cf = global_mean.copy()
            cf[gc] = mean_vec[gc]                         # only this group set to the country's mix
            contrib = decline_of(cf) - base_decline       # +ve → this mix raises declines vs portfolio
            drivers.append({"factor": GROUP_LABEL[g], "pp": round(contrib * 100, 1)})
        country_specific = actual_decline - expected_decline
        drivers.append({"factor": GROUP_LABEL["country"], "pp": round(country_specific * 100, 1)})
        drivers = [d for d in drivers if d["pp"] >= 0.3]
        drivers.sort(key=lambda d: -d["pp"])
        countries[c] = {
            "expected_approval": round(1 - expected_decline, 4),
            "actual_approval": round(1 - actual_decline, 4),
            "gap_pp": round((expected_decline - actual_decline) * 100, 1),   # +ve → worse than mix predicts
            "drivers": drivers[:4],
        }
        if decided >= _MIN_SEGMENT and c != "??":       # can't action an unknown country
            resid_list.append(actual_decline - expected_decline)
            vol_list.append(decided)
            code_list.append(c)

    # ---- anomalies: countries whose actual decline deviates from mix-expected ----
    anomalies = []
    if len(resid_list) >= 4:
        resid = np.array(resid_list)
        rstd = resid.std() or 1.0
        for c, r, v in zip(code_list, resid, vol_list):
            z = (r - resid.mean()) / rstd
            if abs(z) >= 1.5:
                anomalies.append({
                    "country": c, "z": round(float(z), 2), "transactions": int(v),
                    "actual_approval": countries[c]["actual_approval"],
                    "expected_approval": countries[c]["expected_approval"],
                    "direction": "under" if r > 0 else "over",
                })
        anomalies.sort(key=lambda a: -abs(a["z"]))

    # ---- recoverable revenue: lift weak (country,currency) segments to target ----
    cur.execute(f"""
        SELECT {country_case()} country, currency,
               COUNT(*) decided,
               COUNT(*) FILTER (WHERE status = ANY(%(app)s)) approved,
               COALESCE(SUM(captured_minor),0) captured
          FROM transactions
         WHERE status = ANY(%(all)s) AND btrim(COALESCE(country,'')) <> '' {filt}
         GROUP BY 1,2 HAVING COUNT(*) >= 20""",
                {**p, "app": list(APPROVED), "all": [*APPROVED, "auth_failed"]})
    segs = cur.fetchall()
    rates = sorted((s["approved"] / s["decided"]) for s in segs if s["decided"])
    target = float(np.quantile(rates, 0.75)) if rates else 0.0
    by_ccy: dict = {}
    seg_out = []
    recover_by_country: dict = {}
    for s in segs:
        decided = int(s["decided"]); approved = int(s["approved"])
        rate = approved / decided if decided else 0.0
        if rate >= target or approved == 0:
            continue
        avg_ticket = int(s["captured"]) / approved
        rec_txns = (target - rate) * decided
        rec_minor = int(rec_txns * avg_ticket)
        by_ccy[s["currency"]] = by_ccy.get(s["currency"], 0) + rec_minor
        recover_by_country[s["country"]] = recover_by_country.get(s["country"], {"txns": 0.0, "minor": 0})
        recover_by_country[s["country"]]["txns"] += rec_txns
        recover_by_country[s["country"]]["minor"] += rec_minor
        seg_out.append({"country": s["country"], "currency": s["currency"],
                        "current_rate": round(rate, 4), "recover_txns": int(round(rec_txns)),
                        "recover_minor": rec_minor})
    seg_out.sort(key=lambda x: -x["recover_minor"])
    for c, rc in recover_by_country.items():
        countries.setdefault(c, {})["recover_txns"] = int(round(rc["txns"]))
        countries[c]["recover_minor"] = rc["minor"]

    recoverable = {
        "target_approval": round(target, 4),
        "basis": "top-quartile country approval",
        "recover_txns": int(round(sum(r["txns"] for r in recover_by_country.values()))),
        "by_currency": [{"currency": k, "minor": v} for k, v in sorted(by_ccy.items())],
        "segments": seg_out[:8],
    }

    # ---- market clustering: cohorts of similar countries ----
    clusters = _cluster(cur, mid, currency, filt, p)

    result = {
        "available": True,
        "model": {"type": "Logistic regression (mix → approval)", "auc": round(auc, 3), "n": int(n),
                  "features": ["card brand", "issuing bank", "ticket size", "currency", "time of day"]},
        "countries": countries,
        "anomalies": anomalies[:6],
        "recoverable": recoverable,
        "clusters": clusters,
    }
    _cache.clear()
    _cache[key] = result
    return result


def _cluster(cur, mid, currency, filt, p) -> list:
    cur.execute(f"""
        SELECT {country_case()} country,
               COUNT(*) decided,
               COUNT(*) FILTER (WHERE status = ANY(%(app)s)) approved,
               AVG(GREATEST(auth_minor, captured_minor)) avg_amt,
               AVG((payment_brand='APPLEPAY')::int) applepay,
               AVG((payment_brand='VISA')::int) visa
          FROM transactions
         WHERE status = ANY(%(all)s) AND btrim(COALESCE(country,'')) <> '' {filt}
         GROUP BY 1 HAVING COUNT(*) >= %(minseg)s""",
                {**p, "app": list(APPROVED), "all": [*APPROVED, "auth_failed"], "minseg": _MIN_SEGMENT})
    rows = cur.fetchall()
    if len(rows) < 4:
        return []
    codes = [r["country"] for r in rows]
    feats = np.array([[r["approved"] / r["decided"], np.log10(float(r["decided"])),
                       float(r["avg_amt"] or 0), float(r["applepay"] or 0), float(r["visa"] or 0)]
                      for r in rows])
    k = min(4, max(2, len(rows) // 4))
    Z = StandardScaler().fit_transform(feats)
    km = KMeans(n_clusters=k, n_init=10, random_state=0).fit(Z)
    appr = feats[:, 0]
    out = []
    for ci in range(k):
        idx = np.where(km.labels_ == ci)[0]
        if not idx.size:
            continue
        mean_appr = float(appr[idx].mean())
        members = sorted(([codes[i] for i in idx]), key=lambda c: -feats[codes.index(c), 1])
        out.append({"approval": round(mean_appr, 4), "countries": members,
                    "size": int(idx.size)})
    out.sort(key=lambda c: -c["approval"])
    names = _cohort_names(len(out))
    for i, c in enumerate(out):
        c["name"] = names[i]
    return out


def _cohort_names(k: int) -> list:
    if k <= 2:
        return ["Strong markets", "Needs attention"][:k]
    if k == 3:
        return ["Strong markets", "Steady markets", "Needs attention"]
    return ["Strong markets", "Steady markets", "Softening markets", "Needs attention"]
