(function (global) {
  "use strict";

  // Builds the deflected top-of-deck TIN for export.
  //
  // The deck DTM's triangles can run 50+ ft along the bridge, far longer than
  // the deflection curve stays straight, so only moving the DTM's own vertices
  // would lose the sag between them. Instead each DTM triangle is cut by a
  // regular plan grid: every piece keeps the DTM triangle's plane (so crowns
  // and breaklines are untouched) and gains vertices every `cellSize` ft,
  // where the deflection is sampled. Pieces share their cut points, so the
  // result is a conforming TIN.
  //
  // With an overhang offset, a strip is then added along the deck's side
  // edges, out to the screed line, carrying the deck's cross slope and the
  // deflection there.

  const MERGE_TOLERANCE = 1e-6;
  const MERGE_CELL = 1e-4;
  // DTM vertices this close (ft) to a grid line are moved onto it.
  const GRID_SNAP = 1e-4;
  // Fraction of a cell the grid is shifted off the DTM's minimum corner.
  const GRID_SHIFT = 0.381966;

  function signedArea(a, b, c) {
    return ((b.e - a.e) * (c.n - a.n) - (c.e - a.e) * (b.n - a.n)) / 2;
  }

  /** Vertex store that merges points closer than MERGE_TOLERANCE. */
  function vertexStore() {
    const vertices = [];
    const buckets = new Map();
    const keyOf = (e, n) => `${Math.floor(e / MERGE_CELL)}|${Math.floor(n / MERGE_CELL)}`;

    return {
      vertices,
      /** Index of the vertex at (e, n); `make` supplies its data if it is new. */
      add(e, n, make) {
        const ce = Math.floor(e / MERGE_CELL);
        const cn = Math.floor(n / MERGE_CELL);
        for (let de = -1; de <= 1; de += 1) {
          for (let dn = -1; dn <= 1; dn += 1) {
            const bucket = buckets.get(`${ce + de}|${cn + dn}`);
            if (!bucket) continue;
            for (let i = 0; i < bucket.length; i += 1) {
              const vertex = vertices[bucket[i]];
              if (Math.abs(vertex.e - e) <= MERGE_TOLERANCE && Math.abs(vertex.n - n) <= MERGE_TOLERANCE) {
                return bucket[i];
              }
            }
          }
        }
        const index = vertices.length;
        vertices.push({ e, n, ...make() });
        const key = keyOf(e, n);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(index);
        return index;
      },
    };
  }

  /** Sutherland-Hodgman clip of a convex polygon to one axis-aligned half-plane. */
  function clip(polygon, axis, value, keepGreater) {
    const output = [];
    const inside = (p) => (keepGreater ? p[axis] >= value : p[axis] <= value);
    for (let i = 0; i < polygon.length; i += 1) {
      const current = polygon[i];
      const previous = polygon[(i + polygon.length - 1) % polygon.length];
      const currentIn = inside(current);
      const previousIn = inside(previous);
      if (currentIn !== previousIn) {
        const t = (value - previous[axis]) / (current[axis] - previous[axis]);
        const point = {
          e: previous.e + t * (current.e - previous.e),
          n: previous.n + t * (current.n - previous.n),
        };
        point[axis] = value; // land exactly on the grid line
        output.push(point);
      }
      if (currentIn) output.push(current);
    }
    return output;
  }

  function dropRepeats(polygon) {
    const output = [];
    polygon.forEach((point) => {
      const last = output[output.length - 1];
      if (!last || Math.abs(last.e - point.e) > MERGE_TOLERANCE || Math.abs(last.n - point.n) > MERGE_TOLERANCE) {
        output.push(point);
      }
    });
    while (
      output.length > 1 &&
      Math.abs(output[0].e - output[output.length - 1].e) <= MERGE_TOLERANCE &&
      Math.abs(output[0].n - output[output.length - 1].n) <= MERGE_TOLERANCE
    ) {
      output.pop();
    }
    return output;
  }

  /**
   * Triangulates a convex polygon while keeping every boundary point (the
   * neighbouring pieces rely on them). A plain fan works unless the apex is
   * in line with a run of boundary points; then fan from the centroid.
   */
  function triangulateConvex(polygon) {
    const minArea = 1e-9;
    const fan = [];
    let fanOk = true;
    for (let i = 1; i + 1 < polygon.length; i += 1) {
      if (Math.abs(signedArea(polygon[0], polygon[i], polygon[i + 1])) < minArea) {
        fanOk = false;
        break;
      }
      fan.push([0, i, i + 1]);
    }
    if (fanOk) return { centroid: null, triangles: fan };

    const centroid = polygon.reduce((sum, p) => ({ e: sum.e + p.e, n: sum.n + p.n }), { e: 0, n: 0 });
    centroid.e /= polygon.length;
    centroid.n /= polygon.length;
    const triangles = [];
    for (let i = 0; i < polygon.length; i += 1) {
      const j = (i + 1) % polygon.length;
      if (Math.abs(signedArea(centroid, polygon[i], polygon[j])) >= minArea) triangles.push([-1, i, j]);
    }
    return { centroid, triangles };
  }

  /**
   * @param {object} input
   *   points, faces        the deck DTM (points {e, n, z}, faces [a, b, c])
   *   isopachAt(e, n)      deflection (ft) to add at a plan position
   *   cellSize             grid spacing (ft) for densifying the deck
   *   overhangOffset       ft beyond the deck edge to extend to, or null
   *   axis                 {e, n} unit vector along the bridge (to find side edges)
   *   deckZ(e, n)          undeflected deck elevation, for the cross slope
   *   crossSlopeRun        ft of deck, inward from the edge, that sets the cross slope
   */
  function buildDeflectedSurface(input) {
    const { points, faces, isopachAt, cellSize, axis, deckZ } = input;
    const overhangOffset = input.overhangOffset;
    const crossSlopeRun = input.crossSlopeRun ?? 2;
    const store = vertexStore();
    const out = [];

    let originE = Infinity;
    let originN = Infinity;
    points.forEach((p) => {
      if (p.e < originE) originE = p.e;
      if (p.n < originN) originN = p.n;
    });
    // Start the grid an odd fraction of a cell off the DTM, so grid lines do
    // not systematically land on the model's own (often round) coordinates.
    originE -= cellSize * GRID_SHIFT;
    originN -= cellSize * GRID_SHIFT;

    // A DTM vertex a hair off a grid line would leave a sliver gap between
    // the pieces cut on either side of it; put such vertices on the line.
    // Every triangle sharing the vertex sees the same snapped position.
    const snap = (value, origin) => {
      const line = origin + Math.round((value - origin) / cellSize) * cellSize;
      return Math.abs(value - line) <= GRID_SNAP ? line : value;
    };
    const snapped = points.map((p) => (p ? { e: snap(p.e, originE), n: snap(p.n, originN), z: p.z } : p));

    faces.forEach((face) => {
      let [a, b, c] = face.map((index) => snapped[index]);
      if (!a || !b || !c) return;
      const area = signedArea(a, b, c);
      if (Math.abs(area) < 1e-12) return;
      if (area < 0) [b, c] = [c, b];

      // The DTM triangle's plane, used for every piece cut from it.
      const planeZ = (e, n) => {
        const w1 = signedArea({ e, n }, b, c) / signedArea(a, b, c);
        const w2 = signedArea(a, { e, n }, c) / signedArea(a, b, c);
        return w1 * a.z + w2 * b.z + (1 - w1 - w2) * c.z;
      };
      const vertexData = (e, n) => () => {
        const z = planeZ(e, n);
        return { deckZ: z, z: z + isopachAt(e, n) };
      };

      const minE = Math.min(a.e, b.e, c.e);
      const maxE = Math.max(a.e, b.e, c.e);
      const minN = Math.min(a.n, b.n, c.n);
      const maxN = Math.max(a.n, b.n, c.n);
      const i0 = Math.floor((minE - originE) / cellSize);
      const i1 = Math.floor((maxE - originE) / cellSize);
      const j0 = Math.floor((minN - originN) / cellSize);
      const j1 = Math.floor((maxN - originN) / cellSize);

      for (let i = i0; i <= i1; i += 1) {
        const x0 = originE + i * cellSize;
        const x1 = x0 + cellSize;
        for (let j = j0; j <= j1; j += 1) {
          const y0 = originN + j * cellSize;
          const y1 = y0 + cellSize;

          let polygon = [
            { e: a.e, n: a.n },
            { e: b.e, n: b.n },
            { e: c.e, n: c.n },
          ];
          polygon = clip(polygon, "e", x0, true);
          if (polygon.length) polygon = clip(polygon, "e", x1, false);
          if (polygon.length) polygon = clip(polygon, "n", y0, true);
          if (polygon.length) polygon = clip(polygon, "n", y1, false);
          polygon = dropRepeats(polygon);
          if (polygon.length < 3) continue;

          const { centroid, triangles } = triangulateConvex(polygon);
          const ids = polygon.map((p) => store.add(p.e, p.n, vertexData(p.e, p.n)));
          const centroidId = centroid ? store.add(centroid.e, centroid.n, vertexData(centroid.e, centroid.n)) : null;
          triangles.forEach(([p, q, r]) => {
            out.push([p < 0 ? centroidId : ids[p], ids[q], ids[r]]);
          });
        }
      }
    });

    const deckFaces = out.length;
    let stripFaces = 0;
    if (overhangOffset !== null && overhangOffset !== undefined && overhangOffset > 0) {
      stripFaces = addScreedStrip(store, out, { overhangOffset, axis, deckZ, isopachAt, crossSlopeRun });
    }

    // Consistent counter-clockwise faces.
    const vertices = store.vertices;
    const faceList = out
      .filter(([p, q, r]) => p !== q && q !== r && p !== r)
      .map(([p, q, r]) => (signedArea(vertices[p], vertices[q], vertices[r]) < 0 ? [p, r, q] : [p, q, r]));

    return { vertices, faces: faceList, deckFaces, stripFaces };
  }

  /** Adds the strip from the deck's side edges out to the screed line; returns faces added. */
  function addScreedStrip(store, out, options) {
    const { overhangOffset, axis, deckZ, isopachAt, crossSlopeRun } = options;
    const vertices = store.vertices;

    // Boundary edges: used by exactly one face. Keep the opposite vertex to
    // know which side is outward.
    const edges = new Map();
    out.forEach(([p, q, r]) => {
      [
        [p, q, r],
        [q, r, p],
        [r, p, q],
      ].forEach(([u, v, w]) => {
        const key = u < v ? `${u}|${v}` : `${v}|${u}`;
        const existing = edges.get(key);
        if (existing) existing.count += 1;
        else edges.set(key, { u, v, w, count: 1 });
      });
    });

    // Side edges run along the bridge; the ends (abutments) run across it.
    const sideCos = Math.cos((30 * Math.PI) / 180);
    const normals = new Map();
    const sideEdges = [];
    edges.forEach((edge) => {
      if (edge.count !== 1) return;
      const a = vertices[edge.u];
      const b = vertices[edge.v];
      const length = Math.hypot(b.e - a.e, b.n - a.n);
      if (length < 1e-9) return;
      const dirE = (b.e - a.e) / length;
      const dirN = (b.n - a.n) / length;
      if (Math.abs(dirE * axis.e + dirN * axis.n) < sideCos) return;

      let normalE = -dirN;
      let normalN = dirE;
      const opposite = vertices[edge.w];
      if ((opposite.e - a.e) * normalE + (opposite.n - a.n) * normalN > 0) {
        normalE = -normalE;
        normalN = -normalN;
      }
      sideEdges.push(edge);
      [edge.u, edge.v].forEach((index) => {
        const sum = normals.get(index) || { e: 0, n: 0 };
        sum.e += normalE;
        sum.n += normalN;
        normals.set(index, sum);
      });
    });

    // One screed point per side-edge vertex, straight out from the deck edge.
    const screed = new Map();
    normals.forEach((sum, index) => {
      const length = Math.hypot(sum.e, sum.n);
      if (length < 1e-9) return;
      const ne = sum.e / length;
      const nn = sum.n / length;
      const v = vertices[index];

      const inner = deckZ(v.e - ne * crossSlopeRun, v.n - nn * crossSlopeRun);
      const slope = inner === null ? 0 : (v.deckZ - inner) / crossSlopeRun;
      const e = v.e + ne * overhangOffset;
      const n = v.n + nn * overhangOffset;
      const screedDeckZ = v.deckZ + slope * overhangOffset;
      // Read the deflection just inside the screed line, where the isopach
      // mesh still covers it.
      const isopach = isopachAt(v.e + ne * (overhangOffset - 1e-4), v.n + nn * (overhangOffset - 1e-4));
      screed.set(
        index,
        store.add(e, n, () => ({ deckZ: screedDeckZ, z: screedDeckZ + isopach, screed: true })),
      );
    });

    let added = 0;
    sideEdges.forEach((edge) => {
      const su = screed.get(edge.u);
      const sv = screed.get(edge.v);
      if (su === undefined || sv === undefined) return;
      out.push([edge.u, edge.v, sv], [edge.u, sv, su]);
      added += 2;
    });
    return added;
  }

  function escapeXml(text) {
    return String(text).replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch]);
  }

  /** LandXML 1.2 document with one TIN surface. Points are written N E Z. */
  function toLandXml(surface, options = {}) {
    const name = escapeXml(options.name || "Deflected Top of Deck");
    const desc = escapeXml(options.description || "");
    const units =
      options.unitsXml ||
      '<Units><Imperial areaUnit="squareFoot" linearUnit="USSurveyFoot" volumeUnit="cubicYard" ' +
        'temperatureUnit="fahrenheit" pressureUnit="inchHG" diameterUnit="inch" ' +
        'angularUnit="decimal degrees" directionUnit="decimal degrees"></Imperial></Units>';
    const now = options.now || new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    let minZ = Infinity;
    let maxZ = -Infinity;
    surface.vertices.forEach((v) => {
      if (v.z < minZ) minZ = v.z;
      if (v.z > maxZ) maxZ = v.z;
    });

    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" ' +
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
        'xsi:schemaLocation="http://www.landxml.org/schema/LandXML-1.2 http://www.landxml.org/schema/LandXML-1.2/LandXML-1.2.xsd" ' +
        `date="${date}" time="${time}" version="1.2" language="English" readOnly="false">`,
      `\t${units}`,
      '\t<Application name="Survey Toolbox" desc="Bridge Superstructure - deflected top of deck" manufacturer="Survey Toolbox"></Application>',
      "\t<Surfaces>",
      `\t\t<Surface name="${name}" desc="${desc}">`,
      `\t\t\t<Definition surfType="TIN" elevMax="${maxZ.toFixed(6)}" elevMin="${minZ.toFixed(6)}">`,
      "\t\t\t\t<Pnts>",
    ];
    surface.vertices.forEach((v, index) => {
      lines.push(`\t\t\t\t\t<P id="${index + 1}">${v.n.toFixed(6)} ${v.e.toFixed(6)} ${v.z.toFixed(6)}</P>`);
    });
    lines.push("\t\t\t\t</Pnts>", "\t\t\t\t<Faces>");
    surface.faces.forEach(([p, q, r]) => {
      lines.push(`\t\t\t\t\t<F>${p + 1} ${q + 1} ${r + 1}</F>`);
    });
    lines.push("\t\t\t\t</Faces>", "\t\t\t</Definition>", "\t\t</Surface>", "\t</Surfaces>", "</LandXML>", "");
    return lines.join("\n");
  }

  global.BridgeSurfaceExport = { buildDeflectedSurface, toLandXml };
})(typeof window !== "undefined" ? window : globalThis);
