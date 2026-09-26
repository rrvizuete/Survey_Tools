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

    // Position order running opposite to the numbering just means the
    // transverse axis points the other way, which is harmless. Only a genuine
    // reshuffle (non-adjacent girders) is worth flagging.
    const byLabel = sortLabels(girders.map((girder) => girder.label)).join("|");
    const byPosition = ordered.map((girder) => girder.label);
    const forward = byPosition.join("|");
    const reversed = byPosition.slice().reverse().join("|");
    if (byLabel !== forward && byLabel !== reversed) {
      warnings.push(
        `Span ${spanLabel}: girder numbering (${byLabel.split("|").join(", ")}) does not match transverse ` +
          `position (${byPosition.join(", ")}). Using position order for the isopach surface.`,
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
   * them. Push each fascia row outward and copy its values, which holds the
   * fascia deflection across the overhang (the deck keeps its cross slope)
   * instead of dropping to zero at the girder line.
   *
   * With `overhangDistance`, the edge row sits the distance it returns from
   * the fascia girder, square to it. The callback receives the fascia row's
   * points and outward unit normals and returns one distance per point, so
   * the caller can measure from wherever the deck edge actually is. With a
   * plain `overhangOffset`, every point uses that distance. With neither, the
   * fascia row is mirrored by the adjacent girder spacing.
   */
  function addOverhangRows(rows, spanLabel, overhangOffset, overhangDistance) {
    if (rows.length < 2) return rows;
    const useOffset = Number.isFinite(overhangOffset) && overhangOffset > 0;

    /** Unit normal to the girder at each point, pointing away from the neighbour. */
    const outwardNormals = (inner, neighbor) =>
      inner.points.map((point, index) => {
        const other = neighbor.points[index] ?? neighbor.points[neighbor.points.length - 1];
        const awayE = point.e - other.e;
        const awayN = point.n - other.n;

        // Local girder tangent from the neighbouring intervals.
        const before = inner.points[Math.max(0, index - 1)];
        const after = inner.points[Math.min(inner.points.length - 1, index + 1)];
        let tangentE = after.e - before.e;
        let tangentN = after.n - before.n;
        const tangentLength = Math.hypot(tangentE, tangentN);
        if (tangentLength > 1e-9) {
          tangentE /= tangentLength;
          tangentN /= tangentLength;
          const flip = -tangentN * awayE + tangentE * awayN < 0 ? -1 : 1;
          return { e: -tangentN * flip, n: tangentE * flip };
        }
        const awayLength = Math.hypot(awayE, awayN) || 1;
        return { e: awayE / awayLength, n: awayN / awayLength };
      });

    const push = (inner, neighbor, label) => {
      if (!overhangDistance && !useOffset) {
        return {
          girder: label,
          virtual: true,
          points: inner.points.map((point, index) => {
            const other = neighbor.points[index];
            if (!other) return { e: point.e, n: point.n, value: point.value };
            return { e: 2 * point.e - other.e, n: 2 * point.n - other.n, value: point.value };
          }),
        };
      }

      const normals = outwardNormals(inner, neighbor);
      const distances = overhangDistance
        ? overhangDistance({ span: spanLabel, girder: label, points: inner.points, normals })
        : inner.points.map(() => overhangOffset);

      return {
        girder: label,
        virtual: true,
        points: inner.points.map((point, index) => ({
          e: point.e + normals[index].e * distances[index],
          n: point.n + normals[index].n * distances[index],
          value: point.value,
        })),
      };
    };

    const first = rows[0];
    const last = rows[rows.length - 1];

    return [
      push(first, rows[1], first.girder),
      ...rows,
      push(last, rows[rows.length - 2], last.girder),
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

  /** Grid-indexed point location shared by the isopach mesh and the DTM TIN. */
  function makeSampler(triangles) {
    const index = buildGridIndex(triangles);

    return function sampleTriangle(e, n) {
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
          triangle,
          weights,
          value: weights[0] * triangle.v1 + weights[1] * triangle.v2 + weights[2] * triangle.v3,
        };
      }

      return null;
    };
  }

  /**
   * Interpolates elevations over an existing TIN (the LandXML surface faces),
   * so deck elevations can be read at arbitrary plan positions such as girder
   * centerlines rather than only at the surface's own vertices.
   */
  function buildTinInterpolator(points, faces) {
    const triangles = [];

    (faces || []).forEach((face) => {
      const a = points[face[0]];
      const b = points[face[1]];
      const c = points[face[2]];
      if (!a || !b || !c) return;

      triangles.push({
        x1: a.e, y1: a.n, v1: a.z,
        x2: b.e, y2: b.n, v2: b.z,
        x3: c.e, y3: c.n, v3: c.z,
        minX: Math.min(a.e, b.e, c.e), maxX: Math.max(a.e, b.e, c.e),
        minY: Math.min(a.n, b.n, c.n), maxY: Math.max(a.n, b.n, c.n),
      });
    });

    const sampleTriangle = makeSampler(triangles);

    return {
      triangleCount: triangles.length,
      sample(e, n) {
        const hit = sampleTriangle(e, n);
        return hit ? hit.value : null;
      },
    };
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
    const overhangOffset = Number(input.overhangOffset);

    const triangles = [];
    const warnings = [];
    const spans = [];
    const overhangEdges = [];

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

      const rows = addOverhangRows(
        buildRows(girders, warnings, spanLabel),
        spanLabel,
        overhangOffset,
        input.overhangDistance,
      );
      [rows[0], rows[rows.length - 1]].forEach((row) => {
        overhangEdges.push({ span: spanLabel, girder: row.girder, points: row.points.map(({ e, n }) => ({ e, n })) });
      });
      const before = triangles.length;
      buildCells(rows, spanLabel, triangles);
      spans.push({ span: spanLabel, girders: girders.length, triangles: triangles.length - before });
    });

    const sampleTriangle = makeSampler(triangles);

    function sample(e, n) {
      const hit = sampleTriangle(e, n);
      if (!hit) return null;

      return {
        value: hit.value,
        spanKey: hit.triangle.span,
        girderKey: nearestGirder(hit.triangle, hit.weights),
      };
    }

    return {
      sample,
      triangles,
      triangleCount: triangles.length,
      spans,
      overhangEdges,
      warnings,
    };
  }

  /**
   * Even-odd point-in-polygon across every ring, so a point inside an outer
   * ring but also inside an interior ring (a hole) counts as outside.
   */
  function pointInRings(e, n, rings) {
    let inside = false;

    rings.forEach((ring) => {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const ei = ring[i].e;
        const ni = ring[i].n;
        const ej = ring[j].e;
        const nj = ring[j].n;

        if (ni > n !== nj > n && e < ((ej - ei) * (n - ni)) / (nj - ni) + ei) {
          inside = !inside;
        }
      }
    });

    return inside;
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

  global.BridgeIsopach = { buildIsopachMesh, buildTinInterpolator, convexHull, pointInRings };
})(typeof window !== "undefined" ? window : globalThis);
