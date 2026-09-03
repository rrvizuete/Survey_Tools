(function (global) {
  "use strict";

  const INSIDE_EPSILON = 1e-9;

  function sortLabels(labels) {
    return labels.slice().sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  }

  function spanDirection(girders) {
    // Average chord direction across the span's girders, in (e, n).
    let sumE = 0;
    let sumN = 0;

    girders.forEach((girder) => {
      const line = girder.centerline;
      const first = line[0];
      const last = line[line.length - 1];
      const de = last.e - first.e;
      const dn = last.n - first.n;
      const length = Math.hypot(de, dn);
      if (length > 1e-9) {
        sumE += de / length;
        sumN += dn / length;
      }
    });

    const length = Math.hypot(sumE, sumN);
    if (length < 1e-9) return { e: 1, n: 0 };
    return { e: sumE / length, n: sumN / length };
  }

  function buildRows(girders, warnings, spanLabel) {
    const direction = spanDirection(girders);
    // Perpendicular to the span direction: the transverse (girder-to-girder) axis.
    const perpE = -direction.n;
    const perpN = direction.e;

    const ordered = girders
      .map((girder) => {
        const line = girder.centerline;
        const middle = line[Math.floor(line.length / 2)];
        return { girder, projection: middle.e * perpE + middle.n * perpN };
      })
      .sort((a, b) => a.projection - b.projection)
      .map((entry) => entry.girder);

    const byLabel = sortLabels(girders.map((girder) => girder.label));
    const byPosition = ordered.map((girder) => girder.label);
    if (byLabel.join("|") !== byPosition.join("|")) {
      warnings.push(
        `Span ${spanLabel}: girder numbering (${byLabel.join(", ")}) does not match transverse position ` +
          `(${byPosition.join(", ")}). Using position order for the isopach surface.`,
      );
    }

    return ordered.map((girder) => ({
      girder: girder.label,
      virtual: false,
      points: girder.centerline.map((point, index) => ({
        e: point.e,
        n: point.n,
        value: girder.values[index],
      })),
    }));
  }

  /**
   * Deck overhangs cantilever off the exterior girders, so they deflect with
   * them. Mirror each fascia row outward by the adjacent girder spacing and
   * copy its values, which holds the fascia deflection out past the deck edge
   * instead of dropping to zero at the girder line.
   */
  function addOverhangRows(rows) {
    if (rows.length < 2) return rows;

    const mirror = (inner, neighbor, label) => ({
      girder: label,
      virtual: true,
      points: inner.points.map((point, index) => {
        const other = neighbor.points[index];
        if (!other) return { e: point.e, n: point.n, value: point.value };
        return {
          e: point.e + (point.e - other.e),
          n: point.n + (point.n - other.n),
          value: point.value,
        };
      }),
    });

    const first = rows[0];
    const last = rows[rows.length - 1];

    return [
      mirror(first, rows[1], first.girder),
      ...rows,
      mirror(last, rows[rows.length - 2], last.girder),
    ];
  }

  function pushTriangle(triangles, span, a, b, c, girderA, girderB, girderC) {
    const minX = Math.min(a.e, b.e, c.e);
    const maxX = Math.max(a.e, b.e, c.e);
    const minY = Math.min(a.n, b.n, c.n);
    const maxY = Math.max(a.n, b.n, c.n);

    triangles.push({
      span,
      x1: a.e, y1: a.n, v1: a.value, g1: girderA,
      x2: b.e, y2: b.n, v2: b.value, g2: girderB,
      x3: c.e, y3: c.n, v3: c.value, g3: girderC,
      minX, maxX, minY, maxY,
    });
  }

  function buildCells(rows, span, triangles) {
    for (let r = 0; r < rows.length - 1; r += 1) {
      const rowA = rows[r];
      const rowB = rows[r + 1];
      const count = Math.min(rowA.points.length, rowB.points.length);

      for (let i = 0; i < count - 1; i += 1) {
        const a = rowA.points[i];
        const b = rowA.points[i + 1];
        const c = rowB.points[i + 1];
        const d = rowB.points[i];

        // Split the quad along its shorter diagonal to avoid needle triangles.
        const diagonalAC = Math.hypot(c.e - a.e, c.n - a.n);
        const diagonalBD = Math.hypot(d.e - b.e, d.n - b.n);

        if (diagonalAC <= diagonalBD) {
          pushTriangle(triangles, span, a, b, c, rowA.girder, rowA.girder, rowB.girder);
          pushTriangle(triangles, span, a, c, d, rowA.girder, rowB.girder, rowB.girder);
        } else {
          pushTriangle(triangles, span, a, b, d, rowA.girder, rowA.girder, rowB.girder);
          pushTriangle(triangles, span, b, c, d, rowA.girder, rowB.girder, rowB.girder);
        }
      }
    }
  }

  function buildGridIndex(triangles) {
    if (!triangles.length) return null;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    triangles.forEach((triangle) => {
      if (triangle.minX < minX) minX = triangle.minX;
      if (triangle.maxX > maxX) maxX = triangle.maxX;
      if (triangle.minY < minY) minY = triangle.minY;
      if (triangle.maxY > maxY) maxY = triangle.maxY;
    });

    const width = Math.max(maxX - minX, 1e-6);
    const height = Math.max(maxY - minY, 1e-6);
    const target = Math.sqrt((width * height) / triangles.length);
    const cellSize = target > 1e-9 ? target : Math.max(width, height);

    const cols = Math.max(1, Math.min(512, Math.ceil(width / cellSize)));
    const rows = Math.max(1, Math.min(512, Math.ceil(height / cellSize)));
    const buckets = new Array(cols * rows);

    const colOf = (x) => Math.max(0, Math.min(cols - 1, Math.floor(((x - minX) / width) * cols)));
    const rowOf = (y) => Math.max(0, Math.min(rows - 1, Math.floor(((y - minY) / height) * rows)));

    triangles.forEach((triangle, index) => {
      const c0 = colOf(triangle.minX);
      const c1 = colOf(triangle.maxX);
      const r0 = rowOf(triangle.minY);
      const r1 = rowOf(triangle.maxY);

      for (let r = r0; r <= r1; r += 1) {
        for (let c = c0; c <= c1; c += 1) {
          const key = r * cols + c;
          if (!buckets[key]) buckets[key] = [];
          buckets[key].push(index);
        }
      }
    });

    return { minX, maxX, minY, maxY, cols, rows, buckets, colOf, rowOf };
  }

  function barycentric(px, py, triangle) {
    const { x1, y1, x2, y2, x3, y3 } = triangle;
    const denominator = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
    if (Math.abs(denominator) < 1e-12) return null;

    const w1 = ((y2 - y3) * (px - x3) + (x3 - x2) * (py - y3)) / denominator;
    const w2 = ((y3 - y1) * (px - x3) + (x1 - x3) * (py - y3)) / denominator;
    const w3 = 1 - w1 - w2;

    if (w1 < -INSIDE_EPSILON || w2 < -INSIDE_EPSILON || w3 < -INSIDE_EPSILON) return null;
    return [w1, w2, w3];
  }

  function nearestGirder(triangle, weights) {
    const totals = new Map();
    const add = (label, weight) => {
      if (label === undefined || label === null) return;
      totals.set(label, (totals.get(label) || 0) + weight);
    };

    add(triangle.g1, weights[0]);
    add(triangle.g2, weights[1]);
    add(triangle.g3, weights[2]);

    let best = null;
    let bestWeight = -Infinity;
    totals.forEach((weight, label) => {
      if (weight > bestWeight) {
        bestWeight = weight;
        best = label;
      }
    });

    return best;
  }

  function buildIsopachMesh(input) {
    const spanToGirders = input.spanToGirders || {};
    const girderGeometry = input.girderGeometry || {};
    const profiles = input.profiles || {};

    const triangles = [];
    const warnings = [];
    const spans = [];

    sortLabels(Object.keys(spanToGirders)).forEach((spanLabel) => {
      const girderLabels = sortLabels(Array.from(spanToGirders[spanLabel] || []));

      const girders = [];
      girderLabels.forEach((girderLabel) => {
        const key = `${spanLabel}||${girderLabel}`;
        const geometry = girderGeometry[key];
        const profile = profiles[key];
        if (!geometry?.planCenterline?.length || !profile?.length) return;

        const count = Math.min(geometry.planCenterline.length, profile.length);
        girders.push({
          label: girderLabel,
          centerline: geometry.planCenterline.slice(0, count),
          values: profile.slice(0, count).map((point) => point.deflectionIn / 12),
        });
      });

      if (girders.length < 2) {
        warnings.push(
          `Span ${spanLabel}: needs at least two girders to build an isopach surface (found ${girders.length}). ` +
            "Deflection will be treated as 0 across this span.",
        );
        return;
      }

      const rows = addOverhangRows(buildRows(girders, warnings, spanLabel));
      const before = triangles.length;
      buildCells(rows, spanLabel, triangles);
      spans.push({ span: spanLabel, girders: girders.length, triangles: triangles.length - before });
    });

    const index = buildGridIndex(triangles);

    function sample(e, n) {
      if (!index) return null;
      if (e < index.minX || e > index.maxX || n < index.minY || n > index.maxY) return null;

      const bucket = index.buckets[index.rowOf(n) * index.cols + index.colOf(e)];
      if (!bucket) return null;

      for (let i = 0; i < bucket.length; i += 1) {
        const triangle = triangles[bucket[i]];
        if (e < triangle.minX || e > triangle.maxX || n < triangle.minY || n > triangle.maxY) continue;

        const weights = barycentric(e, n, triangle);
        if (!weights) continue;

        return {
          value: weights[0] * triangle.v1 + weights[1] * triangle.v2 + weights[2] * triangle.v3,
          spanKey: triangle.span,
          girderKey: nearestGirder(triangle, weights),
        };
      }

      return null;
    }

    return {
      sample,
      triangles,
      triangleCount: triangles.length,
      spans,
      warnings,
      bounds: index
        ? { minE: index.minX, maxE: index.maxX, minN: index.minY, maxN: index.maxY }
        : null,
    };
  }

  /** Monotone chain convex hull over {e, n} points. */
  function convexHull(points) {
    const unique = [];
    const seen = new Set();
    points.forEach((point) => {
      const key = `${point.e}|${point.n}`;
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(point);
    });

    if (unique.length < 3) return unique.slice();

    const sorted = unique.slice().sort((a, b) => (a.e === b.e ? a.n - b.n : a.e - b.e));
    const cross = (o, a, b) => (a.e - o.e) * (b.n - o.n) - (a.n - o.n) * (b.e - o.e);

    const lower = [];
    sorted.forEach((point) => {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
        lower.pop();
      }
      lower.push(point);
    });

    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const point = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
        upper.pop();
      }
      upper.push(point);
    }

    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  global.BridgeIsopach = { buildIsopachMesh, convexHull };
})(typeof window !== "undefined" ? window : globalThis);
