from __future__ import annotations

from typing import Iterable

import numpy as np


def fit_parabola(points: Iterable[dict]) -> tuple[np.ndarray, float]:
    """Fit y = ax^2 + bx + c using least squares and return coefficients and R².

    Each point is a dict with "station" and "deflection" keys.
    """
    ordered = sorted(points, key=lambda p: p["station"])
    x = np.array([point["station"] for point in ordered], dtype=float)
    y = np.array([point["deflection"] for point in ordered], dtype=float)

    matrix = np.vstack([x**2, x, np.ones_like(x)]).T
    coefficients, *_ = np.linalg.lstsq(matrix, y, rcond=None)

    y_pred = matrix @ coefficients
    ss_res = float(np.sum((y - y_pred) ** 2))
    ss_tot = float(np.sum((y - np.mean(y)) ** 2))
    r_squared = 1.0 if ss_tot == 0 else 1 - (ss_res / ss_tot)

    return coefficients, r_squared


def build_profile(points: Iterable[dict], intervals: int) -> tuple[np.ndarray, np.ndarray]:
    """Generate interpolated profile values from parabola fit and interval count."""
    ordered = sorted(points, key=lambda p: p["station"])
    start_station = ordered[0]["station"]
    end_station = ordered[-1]["station"]

    coefficients, _ = fit_parabola(ordered)

    stations = np.linspace(start_station, end_station, intervals + 1)
    a, b, c = coefficients
    deflections = (a * stations**2) + (b * stations) + c

    return stations, deflections
