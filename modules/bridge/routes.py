from flask import jsonify, render_template, request

from . import bridge_bp
from .core.deflection import build_profile, fit_parabola


def _parse_points(raw_points):
    if not isinstance(raw_points, list) or len(raw_points) < 3:
        raise ValueError("'points' must be a list of at least 3 {station, deflection} objects.")

    points = []
    for raw_point in raw_points:
        if not isinstance(raw_point, dict):
            raise ValueError("Each point must be a JSON object with 'station' and 'deflection'.")
        try:
            station = float(raw_point["station"])
            deflection = float(raw_point["deflection"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("Each point needs numeric 'station' and 'deflection' values.")
        points.append({"station": station, "deflection": deflection})

    return points


@bridge_bp.route("/")
def index():
    return render_template("bridge/index.html")


@bridge_bp.route("/api/health")
def health():
    return jsonify({"status": "ok"})


@bridge_bp.route("/api/fit-parabola", methods=["POST"])
def fit_parabola_endpoint():
    payload = request.get_json(silent=True) or {}
    try:
        points = _parse_points(payload.get("points"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    coefficients, r_squared = fit_parabola(points)
    return jsonify({"coefficients": coefficients.tolist(), "r_squared": r_squared})


@bridge_bp.route("/api/build-profile", methods=["POST"])
def build_profile_endpoint():
    payload = request.get_json(silent=True) or {}
    try:
        points = _parse_points(payload.get("points"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    intervals = payload.get("intervals", 10)
    try:
        intervals = int(intervals)
    except (TypeError, ValueError):
        return jsonify({"error": "'intervals' must be an integer."}), 400
    if not (2 <= intervals <= 500):
        return jsonify({"error": "'intervals' must be between 2 and 500."}), 400

    coefficients, _ = fit_parabola(points)
    stations, deflections = build_profile(points, intervals)

    profile = [
        {"station": float(station), "deflection": float(deflection)}
        for station, deflection in zip(stations, deflections)
    ]

    return jsonify({"coefficients": coefficients.tolist(), "profile": profile})
