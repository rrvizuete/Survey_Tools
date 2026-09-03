(function (global) {
  "use strict";

  function localNameOf(node) {
    return node.localName || String(node.nodeName || "").replace(/^.*:/, "");
  }

  function tagList(root, tagName) {
    // Namespace-agnostic descendant lookup. One live-collection call per tag,
    // then index iteration with a cached length (a deck DTM can hold 50k+ nodes).
    const collection = root.getElementsByTagNameNS("*", tagName);
    if (collection && collection.length !== undefined) return collection;
    return root.getElementsByTagName(tagName);
  }

  function numbersFrom(text) {
    if (!text) return [];
    return String(text)
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((value) => Number.isFinite(value));
  }

  function parsePoints(surfaceEl) {
    const points = [];
    const byId = new Map();

    const nodes = tagList(surfaceEl, "P");
    const count = nodes.length;
    for (let index = 0; index < count; index += 1) {
      const node = nodes[index];
      const values = numbersFrom(node.textContent);
      if (values.length < 3) continue;

      const id = node.getAttribute("id") ?? String(points.length + 1);
      const point = {
        id,
        n: values[0],
        e: values[1],
        z: values[2],
        name: node.getAttribute("name") || node.getAttribute("desc") || "",
      };

      byId.set(String(id), points.length);
      points.push(point);
    }

    return { points, byId };
  }

  function parseFaces(surfaceEl, byId) {
    const faces = [];
    const nodes = tagList(surfaceEl, "F");
    const count = nodes.length;

    for (let index = 0; index < count; index += 1) {
      const node = nodes[index];
      const ids = String(node.textContent || "").trim().split(/\s+/);
      if (ids.length < 3) continue;

      const a = byId.get(ids[0]);
      const b = byId.get(ids[1]);
      const c = byId.get(ids[2]);
      if (a === undefined || b === undefined || c === undefined) continue;

      faces.push([a, b, c]);
    }

    return faces;
  }

  function parseBoundaries(surfaceEl) {
    const rings = [];
    const nodes = tagList(surfaceEl, "Boundary");
    const count = nodes.length;

    for (let index = 0; index < count; index += 1) {
      const boundary = nodes[index];
      const lists2d = tagList(boundary, "PntList2D");
      const lists3d = tagList(boundary, "PntList3D");
      const listNode = lists2d.length ? lists2d[0] : lists3d.length ? lists3d[0] : null;
      if (!listNode) continue;

      const stride = lists2d.length ? 2 : 3;
      const values = numbersFrom(listNode.textContent);
      const ring = [];
      for (let i = 0; i + 1 < values.length; i += stride) {
        ring.push({ n: values[i], e: values[i + 1] });
      }

      if (ring.length >= 3) {
        rings.push({
          type: (boundary.getAttribute("bndType") || "outer").toLowerCase(),
          points: ring,
        });
      }
    }

    return rings;
  }

  function boundsOf(points) {
    if (!points.length) return null;
    let minN = Infinity;
    let maxN = -Infinity;
    let minE = Infinity;
    let maxE = -Infinity;

    points.forEach((point) => {
      if (point.n < minN) minN = point.n;
      if (point.n > maxN) maxN = point.n;
      if (point.e < minE) minE = point.e;
      if (point.e > maxE) maxE = point.e;
    });

    return { minN, maxN, minE, maxE };
  }

  function parseLandXml(text) {
    const doc = new global.DOMParser().parseFromString(text, "application/xml");

    const parseError = doc.getElementsByTagName("parsererror");
    if (parseError && parseError.length) {
      throw new Error("The XML file could not be parsed. Confirm it is a valid LandXML export.");
    }

    const surfaceNodes = tagList(doc.documentElement, "Surface");
    const surfaces = [];

    for (let index = 0; index < surfaceNodes.length; index += 1) {
      const surfaceEl = surfaceNodes[index];
      const { points, byId } = parsePoints(surfaceEl);
      if (!points.length) continue;

      surfaces.push({
        name: surfaceEl.getAttribute("name") || `Surface ${surfaces.length + 1}`,
        points,
        faces: parseFaces(surfaceEl, byId),
        boundaries: parseBoundaries(surfaceEl),
        bounds: boundsOf(points),
      });
    }

    if (!surfaces.length) {
      throw new Error("No surface points were found. Expected a LandXML <Surface> with <Pnts><P> entries.");
    }

    return { surfaces };
  }

  function rangesOverlap(aMin, aMax, bMin, bMax) {
    return aMin <= bMax && bMin <= aMax;
  }

  /**
   * Some exporters write "east north elev" instead of the LandXML-standard
   * "north east elev". Compare against the girder footprint: if the axes only
   * line up when swapped, the caller should warn rather than silently produce
   * a surface that does not overlap the bridge.
   */
  function detectSwappedAxes(surfaceBounds, girderBounds) {
    if (!surfaceBounds || !girderBounds) return false;

    const asImported =
      rangesOverlap(surfaceBounds.minN, surfaceBounds.maxN, girderBounds.minN, girderBounds.maxN) &&
      rangesOverlap(surfaceBounds.minE, surfaceBounds.maxE, girderBounds.minE, girderBounds.maxE);

    const asSwapped =
      rangesOverlap(surfaceBounds.minE, surfaceBounds.maxE, girderBounds.minN, girderBounds.maxN) &&
      rangesOverlap(surfaceBounds.minN, surfaceBounds.maxN, girderBounds.minE, girderBounds.maxE);

    return !asImported && asSwapped;
  }

  /** Edges referenced by exactly one face, chained into closed rings. */
  function extractBoundaryRings(points, faces) {
    const edgeUse = new Map();

    const addEdge = (a, b) => {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const existing = edgeUse.get(key);
      if (existing) existing.count += 1;
      else edgeUse.set(key, { a, b, count: 1 });
    };

    faces.forEach((face) => {
      addEdge(face[0], face[1]);
      addEdge(face[1], face[2]);
      addEdge(face[2], face[0]);
    });

    const adjacency = new Map();
    edgeUse.forEach((edge) => {
      if (edge.count !== 1) return;
      if (!adjacency.has(edge.a)) adjacency.set(edge.a, []);
      if (!adjacency.has(edge.b)) adjacency.set(edge.b, []);
      adjacency.get(edge.a).push(edge.b);
      adjacency.get(edge.b).push(edge.a);
    });

    const rings = [];
    const visited = new Set();

    adjacency.forEach((_neighbors, start) => {
      if (visited.has(start)) return;

      const ring = [];
      let current = start;
      let previous = null;

      while (current !== undefined && !visited.has(current)) {
        visited.add(current);
        ring.push(points[current]);

        const neighbors = adjacency.get(current) || [];
        const next = neighbors.find((candidate) => candidate !== previous && !visited.has(candidate));
        previous = current;
        current = next;
      }

      if (ring.length >= 3) rings.push(ring);
    });

    return rings;
  }

  global.BridgeLandXml = {
    parseLandXml,
    detectSwappedAxes,
    extractBoundaryRings,
    boundsOf,
  };
})(typeof window !== "undefined" ? window : globalThis);
