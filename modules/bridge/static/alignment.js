(function (global) {
  "use strict";

  // Everything here works in plan (e, n) with the usual survey convention:
  // headings are math angles measured from +E toward +N, so "ccw" rotation in
  // LandXML is a positive heading change and offsets are positive to the right.

  const SPIRAL_STEPS = 64;

  function localNameOf(node) {
    return node.localName || String(node.nodeName || "").replace(/^.*:/, "");
  }

  function tagList(root, tagName) {
    const collection = root.getElementsByTagNameNS("*", tagName);
    if (collection && collection.length !== undefined) return collection;
    return root.getElementsByTagName(tagName);
  }

  function childElements(node) {
    const children = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) children.push(child);
    }
    return children;
  }

  function childNamed(node, name) {
    return childElements(node).find((child) => localNameOf(child) === name) || null;
  }

  /** LandXML points are "north east [elev]". */
  function pointOf(node) {
    if (!node) return null;
    const values = String(node.textContent || "")
      .trim()
      .split(/\s+/)
      .map(Number);
    if (values.length < 2 || !values.slice(0, 2).every(Number.isFinite)) return null;
    return { n: values[0], e: values[1] };
  }

  function numberAttr(node, name) {
    const raw = node.getAttribute(name);
    if (raw === null || raw === "") return null;
    if (/^inf/i.test(raw.trim())) return Infinity;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  function headingOf(from, to) {
    return Math.atan2(to.n - from.n, to.e - from.e);
  }

  function normalizeAngle(angle) {
    let output = angle;
    while (output <= -Math.PI) output += 2 * Math.PI;
    while (output > Math.PI) output -= 2 * Math.PI;
    return output;
  }

  function rotationSign(node, fallback) {
    const rot = String(node.getAttribute("rot") || "").toLowerCase();
    if (rot === "ccw") return 1;
    if (rot === "cw") return -1;
    return fallback;
  }

  function lineElement(start, end) {
    const length = Math.hypot(end.e - start.e, end.n - start.n);
    const heading = headingOf(start, end);
    const dirE = Math.cos(heading);
    const dirN = Math.sin(heading);
    return {
      type: "Line",
      length,
      start,
      end,
      at(s) {
        return { e: start.e + dirE * s, n: start.n + dirN * s, heading };
      },
    };
  }

  function curveElement(node, previousHeading) {
    const start = pointOf(childNamed(node, "Start"));
    const end = pointOf(childNamed(node, "End"));
    const center = pointOf(childNamed(node, "Center"));
    const pi = pointOf(childNamed(node, "PI"));
    if (!start || !end || !center) {
      throw new Error("A <Curve> is missing its Start, End, or Center point.");
    }

    // Prefer the explicit rotation; otherwise read the turn from the PI or
    // from the incoming tangent.
    let fallback = 1;
    if (pi) {
      const cross = (pi.e - start.e) * (end.n - pi.n) - (pi.n - start.n) * (end.e - pi.e);
      fallback = cross >= 0 ? 1 : -1;
    } else if (previousHeading !== null) {
      const radial = headingOf(center, start);
      fallback = normalizeAngle(previousHeading - radial) > 0 ? 1 : -1;
    }
    const sign = rotationSign(node, fallback);

    const radius = Math.hypot(start.e - center.e, start.n - center.n);
    const a0 = headingOf(center, start);
    let delta = headingOf(center, end) - a0;
    if (sign > 0) while (delta <= 0) delta += 2 * Math.PI;
    else while (delta >= 0) delta -= 2 * Math.PI;
    // A full circle or a zero-length arc both come out as ±2π; treat an arc
    // whose start and end coincide as zero length.
    if (Math.hypot(end.e - start.e, end.n - start.n) < 1e-9) delta = 0;

    return {
      type: "Curve",
      length: radius * Math.abs(delta),
      start,
      end,
      at(s) {
        const angle = a0 + (sign * s) / radius;
        return {
          e: center.e + radius * Math.cos(angle),
          n: center.n + radius * Math.sin(angle),
          heading: angle + (sign * Math.PI) / 2,
        };
      },
    };
  }

  function spiralElement(node, previousHeading, warnings) {
    const start = pointOf(childNamed(node, "Start"));
    const end = pointOf(childNamed(node, "End"));
    const pi = pointOf(childNamed(node, "PI"));
    const length = numberAttr(node, "length");
    const radiusStart = numberAttr(node, "radiusStart");
    const radiusEnd = numberAttr(node, "radiusEnd");

    if (!start || !end || !(length > 0) || radiusStart === null || radiusEnd === null) {
      throw new Error("A <Spiral> needs Start, End, length, radiusStart, and radiusEnd.");
    }

    const spiType = String(node.getAttribute("spiType") || "clothoid").toLowerCase();
    if (spiType !== "clothoid") {
      warnings.push(`Spiral type "${spiType}" is approximated as a clothoid.`);
    }

    let heading0 = pi ? headingOf(start, pi) : previousHeading;
    if (heading0 === null) heading0 = headingOf(start, end);

    const sign = rotationSign(node, 1);
    const k0 = Number.isFinite(radiusStart) && radiusStart !== 0 ? 1 / radiusStart : 0;
    const k1 = Number.isFinite(radiusEnd) && radiusEnd !== 0 ? 1 / radiusEnd : 0;
    const headingAt = (s) => heading0 + sign * (k0 * s + ((k1 - k0) * s * s) / (2 * length));

    // Clothoid position by Simpson integration of the heading.
    const rawAt = (s) => {
      if (s <= 0) return { e: 0, n: 0 };
      const steps = SPIRAL_STEPS;
      const h = s / steps;
      let sumE = 0;
      let sumN = 0;
      for (let i = 0; i <= steps; i += 1) {
        const weight = i === 0 || i === steps ? 1 : i % 2 ? 4 : 2;
        const theta = headingAt(i * h);
        sumE += weight * Math.cos(theta);
        sumN += weight * Math.sin(theta);
      }
      return { e: (sumE * h) / 3, n: (sumN * h) / 3 };
    };

    // Exporters round the spiral parameters, so snap the integrated shape onto
    // the stated End with a tiny rotation + scale about Start. That keeps the
    // chain continuous without visibly bending the spiral.
    const rawEnd = rawAt(length);
    const rawLength = Math.hypot(rawEnd.e, rawEnd.n);
    const targetE = end.e - start.e;
    const targetN = end.n - start.n;
    const targetLength = Math.hypot(targetE, targetN);
    let rotate = 0;
    let scale = 1;
    if (rawLength > 1e-9 && targetLength > 1e-9) {
      rotate = normalizeAngle(Math.atan2(targetN, targetE) - Math.atan2(rawEnd.n, rawEnd.e));
      scale = targetLength / rawLength;
    }
    if (Math.abs(rotate) > 0.01 || Math.abs(scale - 1) > 0.01) {
      warnings.push(
        `Spiral starting at N ${start.n.toFixed(3)} E ${start.e.toFixed(3)} does not close on its End point ` +
          "within 1%; check the export.",
      );
    }
    const cosR = Math.cos(rotate) * scale;
    const sinR = Math.sin(rotate) * scale;

    return {
      type: "Spiral",
      length,
      start,
      end,
      at(s) {
        const raw = rawAt(s);
        return {
          e: start.e + raw.e * cosR - raw.n * sinR,
          n: start.n + raw.e * sinR + raw.n * cosR,
          heading: headingAt(s) + rotate,
        };
      },
    };
  }

  function irregularLineElements(node) {
    const list = childNamed(node, "PntList2D") || childNamed(node, "PntList3D");
    if (!list) return [];
    const stride = localNameOf(list) === "PntList2D" ? 2 : 3;
    const values = String(list.textContent || "").trim().split(/\s+/).map(Number);
    const points = [];
    for (let i = 0; i + 1 < values.length; i += stride) points.push({ n: values[i], e: values[i + 1] });

    const elements = [];
    for (let i = 0; i + 1 < points.length; i += 1) elements.push(lineElement(points[i], points[i + 1]));
    return elements;
  }

  function buildAlignment(alignmentEl) {
    const name = alignmentEl.getAttribute("name") || "Alignment";
    const staStart = numberAttr(alignmentEl, "staStart") ?? 0;
    const warnings = [];
    const elements = [];

    const coordGeom = childNamed(alignmentEl, "CoordGeom");
    if (!coordGeom) throw new Error(`Alignment "${name}" has no <CoordGeom>.`);

    let previousHeading = null;
    childElements(coordGeom).forEach((node) => {
      const type = localNameOf(node);
      let added = [];
      if (type === "Line") {
        const start = pointOf(childNamed(node, "Start"));
        const end = pointOf(childNamed(node, "End"));
        if (start && end) added = [lineElement(start, end)];
      } else if (type === "Curve") {
        added = [curveElement(node, previousHeading)];
      } else if (type === "Spiral") {
        added = [spiralElement(node, previousHeading, warnings)];
      } else if (type === "IrregularLine") {
        added = irregularLineElements(node);
      } else {
        warnings.push(`Unsupported geometry <${type}> was skipped.`);
      }

      added.forEach((element) => {
        if (!(element.length > 1e-9)) return;
        elements.push(element);
        previousHeading = element.at(element.length).heading;
      });
    });

    if (!elements.length) throw new Error(`Alignment "${name}" has no usable line, curve, or spiral geometry.`);

    for (let i = 1; i < elements.length; i += 1) {
      const gap = Math.hypot(elements[i].start.e - elements[i - 1].end.e, elements[i].start.n - elements[i - 1].end.n);
      if (gap > 0.01) {
        warnings.push(`Gap of ${gap.toFixed(3)} ft between geometry elements ${i} and ${i + 1}.`);
      }
    }

    if (tagList(alignmentEl, "StaEquation").length) {
      warnings.push("Station equations are present but ignored; stations run continuously from the start station.");
    }

    // Cumulative start distance of each element along the alignment.
    const offsets = [];
    let total = 0;
    elements.forEach((element) => {
      offsets.push(total);
      total += element.length;
    });

    function elementIndexAt(distance) {
      let low = 0;
      let high = elements.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (offsets[mid] <= distance) low = mid;
        else high = mid - 1;
      }
      return low;
    }

    /** Plan position, heading, and unit right-hand normal at a station. */
    function pointAt(station) {
      const distance = Math.max(0, Math.min(total, station - staStart));
      const index = elementIndexAt(distance);
      const local = elements[index].at(distance - offsets[index]);
      const dirE = Math.cos(local.heading);
      const dirN = Math.sin(local.heading);
      return { e: local.e, n: local.n, dirE, dirN, rightE: dirN, rightN: -dirE };
    }

    // Densified copy for projecting arbitrary points back onto the alignment.
    const polyline = [];
    elements.forEach((element, index) => {
      const pieces = element.type === "Line" ? 1 : Math.max(4, Math.ceil(element.length / 2));
      for (let i = index === 0 ? 0 : 1; i <= pieces; i += 1) {
        const s = (element.length * i) / pieces;
        const local = element.at(s);
        polyline.push({ e: local.e, n: local.n, station: staStart + offsets[index] + s });
      }
    });

    /** Station and signed offset (right positive) of a plan point. */
    function stationOffsetOf(e, n) {
      let best = null;
      for (let i = 0; i + 1 < polyline.length; i += 1) {
        const a = polyline[i];
        const b = polyline[i + 1];
        const dE = b.e - a.e;
        const dN = b.n - a.n;
        const lengthSq = dE * dE + dN * dN;
        if (lengthSq < 1e-18) continue;
        const u = Math.max(0, Math.min(1, ((e - a.e) * dE + (n - a.n) * dN) / lengthSq));
        const pE = a.e + u * dE;
        const pN = a.n + u * dN;
        const distance = Math.hypot(e - pE, n - pN);
        if (!best || distance < best.distance) {
          const length = Math.sqrt(lengthSq);
          // Cross product sign: point to the right of travel is positive.
          const side = ((e - a.e) * dN - (n - a.n) * dE) / length;
          best = { distance, station: a.station + u * (b.station - a.station), offset: side };
        }
      }
      if (!best) return null;

      // Polish against the exact geometry: slide along the tangent until the
      // point is square to the alignment.
      let station = best.station;
      for (let i = 0; i < 4; i += 1) {
        const frame = pointAt(station);
        const along = (e - frame.e) * frame.dirE + (n - frame.n) * frame.dirN;
        station = Math.max(staStart, Math.min(staStart + total, station + along));
        if (Math.abs(along) < 1e-7) break;
      }
      const frame = pointAt(station);
      return { station, offset: (e - frame.e) * frame.rightE + (n - frame.n) * frame.rightN };
    }

    return {
      name,
      staStart,
      staEnd: staStart + total,
      length: total,
      elementCount: elements.length,
      warnings,
      polyline,
      pointAt,
      stationOffsetOf,
    };
  }

  function parseAlignments(text) {
    const doc = new global.DOMParser().parseFromString(text, "application/xml");
    const parseError = doc.getElementsByTagName("parsererror");
    if (parseError && parseError.length) {
      throw new Error("The XML file could not be parsed. Confirm it is a valid LandXML export.");
    }

    const nodes = tagList(doc.documentElement, "Alignment");
    const alignments = [];
    const errors = [];
    for (let i = 0; i < nodes.length; i += 1) {
      try {
        alignments.push(buildAlignment(nodes[i]));
      } catch (error) {
        errors.push(error.message);
      }
    }

    if (!alignments.length) {
      throw new Error(
        errors.length
          ? `No usable alignment was found: ${errors.join(" ")}`
          : "No alignment was found. Expected a LandXML <Alignment> with <CoordGeom> geometry.",
      );
    }

    return { alignments, errors };
  }

  /** 1234.5 -> "12+34.50" */
  function formatStation(station, decimals = 2) {
    const sign = station < 0 ? "-" : "";
    const rounded = Math.abs(station).toFixed(decimals);
    const [whole, fraction] = rounded.split(".");
    const hundreds = Math.floor(Number(whole) / 100);
    const rest = String(Number(whole) % 100).padStart(2, "0");
    return `${sign}${hundreds}+${rest}${fraction ? `.${fraction}` : ""}`;
  }

  /** Accepts "12+34.5" or "1234.5". */
  function parseStation(text) {
    const raw = String(text ?? "").trim();
    if (!raw) return null;
    const match = raw.match(/^(-?)(\d+)\+(\d+(?:\.\d*)?)$/);
    if (match) {
      const value = Number(match[2]) * 100 + Number(match[3]);
      return match[1] ? -value : value;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * Offsets along the section line (origin + offset * right) where a plan
   * polyline crosses it, with the parameter along the polyline for sampling.
   */
  function crossingsOf(origin, right, polyline) {
    const hits = [];
    for (let i = 0; i + 1 < polyline.length; i += 1) {
      const a = polyline[i];
      const b = polyline[i + 1];
      const dE = b.e - a.e;
      const dN = b.n - a.n;
      // Solve origin + t * right = a + u * (b - a).
      const denominator = right.e * -dN - right.n * -dE;
      if (Math.abs(denominator) < 1e-12) continue;
      const rE = a.e - origin.e;
      const rN = a.n - origin.n;
      const t = (rE * -dN - rN * -dE) / denominator;
      const u = (right.e * rN - right.n * rE) / denominator;
      if (u < -1e-9 || u > 1 + 1e-9) continue;
      hits.push({ offset: t, index: i, u: Math.max(0, Math.min(1, u)) });
    }
    return hits;
  }

  global.BridgeAlignment = { parseAlignments, formatStation, parseStation, crossingsOf };
})(typeof window !== "undefined" ? window : globalThis);
