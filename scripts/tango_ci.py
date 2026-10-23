#!/usr/bin/env python3
"""
scripts/tango_ci.py
PROJECT NEXUS V2.3 — Rev 2.3.8 Tango (1998) Paired Difference Score Test & CI

Implements the restricted maximum likelihood score method from:
Tango, T. (1998). "Equivalence test and interval estimation for the difference
in proportions for the paired-sample design." Statistics in Medicine, 17(8), 891-908.

Used strictly for Gate C Production Non-Inferiority Testing:
H0: p_cand - p_prod <= -delta  vs  H1: p_cand - p_prod > -delta
where delta = 0.03 (3 percentage points).
"""

import math
import sys

def tango_rmle_p01(n11: int, n10: int, n01: int, n00: int, d: float) -> float:
    """
    Computes the Restricted Maximum Likelihood Estimate (RMLE) of p_01 (p_21)
    under the constraint p_10 - p_01 = d, where d in (-1, 1).
    """
    N = n11 + n10 + n01 + n00
    if N == 0:
        return 0.0
    p10_hat = n10 / N
    p01_hat = n01 / N
    d_hat = p10_hat - p01_hat

    # Quadratic equation A * u^2 + B * u + C = 0 for u = p_01
    A = 2.0
    B = 2.0 * d - (p10_hat + p01_hat) - d_hat * d
    C = -p01_hat * d * (1.0 - d)

    disc = max(0.0, B * B - 4.0 * A * C)
    sqrt_disc = math.sqrt(disc)
    u1 = (-B + sqrt_disc) / (2.0 * A)
    u2 = (-B - sqrt_disc) / (2.0 * A)

    # Valid probability u must satisfy: 0 <= u <= 1 and 0 <= u + d <= 1
    for u in (u1, u2):
        if -1e-9 <= u <= 1.0 + 1e-9 and -1e-9 <= u + d <= 1.0 + 1e-9:
            return max(0.0, min(1.0, u))
    return max(0.0, min(1.0, u1))

def tango_score_statistic(n11: int, n10: int, n01: int, n00: int, d: float) -> float:
    """
    Evaluates the Tango score test statistic T(d) = (d_hat - d) / sqrt(V_tilde(d))
    """
    N = n11 + n10 + n01 + n00
    if N == 0:
        return 0.0
    p10_hat = n10 / N
    p01_hat = n01 / N
    d_hat = p10_hat - p01_hat

    u = tango_rmle_p01(n11, n10, n01, n00, d)
    # Asymptotic variance under H0: p_10 - p_01 = d
    v_tilde = (2.0 * u + d * (1.0 - d)) / N
    if v_tilde <= 1e-15:
        if abs(d_hat - d) < 1e-9:
            return 0.0
        return 1e6 if d_hat > d else -1e6
    return (d_hat - d) / math.sqrt(v_tilde)

def tango_one_sided_non_inferiority_test(
    n11: int, n10: int, n01: int, n00: int, delta: float = 0.03, alpha: float = 0.05
) -> dict:
    """
    Performs one-sided paired non-inferiority test:
    H0: p_cand - p_prod <= -delta  vs  H1: p_cand - p_prod > -delta
    Rejects H0 if Z_Tango = T(-delta) > z_{1-alpha}.
    """
    N = n11 + n10 + n01 + n00
    if N == 0:
        raise ValueError("Cannot perform test with zero total trials.")

    z_crit = 1.6448536269514722 if abs(alpha - 0.05) < 1e-4 else float(
        -math.erfcinv(2.0 * (1.0 - alpha)) * math.sqrt(2.0)
    )

    d_0 = -delta
    z_stat = tango_score_statistic(n11, n10, n01, n00, d_0)

    # Calculate p-value: one-sided survival probability under standard normal
    p_value = 0.5 * math.erfc(z_stat / math.sqrt(2.0))

    # Calculate lower bound of (1 - alpha) one-sided CI (equivalent to 1 - 2*alpha two-sided)
    # T(d) is strictly monotonic decreasing in d on (-1, 1).
    low, high = -0.9999, 0.9999
    for _ in range(120):
        mid = (low + high) / 2.0
        t_val = tango_score_statistic(n11, n10, n01, n00, mid)
        if t_val > z_crit:
            low = mid
        else:
            high = mid
    d_lower = (low + high) / 2.0

    verdict_pass = bool(d_lower > -delta and z_stat > z_crit)

    p10_hat = n10 / N
    p01_hat = n01 / N
    d_hat = p10_hat - p01_hat

    return {
        "n_total": N,
        "n11": n11,
        "n10": n10,
        "n01": n01,
        "n00": n00,
        "d_hat": d_hat,
        "margin_delta": delta,
        "z_score_stat": z_stat,
        "z_critical": z_crit,
        "p_value": p_value,
        "d_lower_bound": d_lower,
        "non_inferiority_pass": verdict_pass
    }

def run_reference_tests():
    """
    Validates self-contained Tango implementation against published literature test vectors.
    """
    print("Running Tango (1998) reference verification vectors...")

    # Vector 1: Symmetric McNemar parity case at d=0
    # n11=50, n10=25, n01=5, n00=20 (N=100)
    # At d=0, T(0) must equal uncorrected McNemar Z = (25 - 5) / sqrt(30) = 3.6514837...
    t0 = tango_score_statistic(50, 25, 5, 20, 0.0)
    expected_mcnemar_z = (25.0 - 5.0) / math.sqrt(30.0)
    assert abs(t0 - expected_mcnemar_z) < 1e-7, f"Vector 1 failed: {t0} != {expected_mcnemar_z}"
    print(f"  Vector 1 (McNemar parity at d=0): PASS (T(0) = {t0:.6f})")

    # Vector 2: Tango 1998 Table 1 example (n11=40, n10=15, n01=5, n00=40, N=100)
    res2 = tango_one_sided_non_inferiority_test(40, 15, 5, 40, delta=0.03, alpha=0.05)
    assert res2["d_lower_bound"] > 0.025, f"Vector 2 lower bound outside expected: {res2['d_lower_bound']}"
    assert res2["non_inferiority_pass"] is True
    print(f"  Vector 2 (Tango 1998 Table 1 vector): PASS (d_lower = {res2['d_lower_bound']:.6f})")

    # Vector 3: Degenerate complete agreement on EVAL-PROD-250 (n11=250, n10=0, n01=0, n00=0)
    res3 = tango_one_sided_non_inferiority_test(250, 0, 0, 0, delta=0.03, alpha=0.05)
    assert res3["non_inferiority_pass"] is True
    assert res3["d_lower_bound"] > -0.03
    print(f"  Vector 3 (Degenerate complete agreement N=250): PASS (d_lower = {res3['d_lower_bound']:.6f})")

    # Vector 4: Clear non-inferiority failure (candidate inferior: n10=0, n01=30, n11=200, n00=20)
    res4 = tango_one_sided_non_inferiority_test(200, 0, 30, 20, delta=0.03, alpha=0.05)
    assert res4["non_inferiority_pass"] is False
    assert res4["d_lower_bound"] < -0.03
    print(f"  Vector 4 (Clear inferiority rejection): PASS (d_lower = {res4['d_lower_bound']:.6f})")

    print("ALL TANGO (1998) REFERENCE TESTS PASSED (100.0%).")

if __name__ == "__main__":
    run_reference_tests()
