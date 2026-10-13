/**
 * End-to-end check of the deflected deck: drives the real Bridge page in
 * headless Chromium, uploads a girder workbook and a top-of-deck DTM through
 * the page's own file inputs, runs Calculate and Compute deck, then checks
 * that at the girder points the deflected deck minus the original deck
 * elevation equals the computed girder deflection.
 *
 * Run: node --test modules/bridge/tests/deck_deflection.e2e.js
 * (needs Playwright with Chromium; the Flask app is started on a free port).
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require(path.join(process.execPath, "../../lib/node_modules/playwright")));
}

const REPO_ROOT = path.resolve(__dirname, "../../..");
const TOLERANCE_FT = 1e-6;
const INTERVALS = 12; // hits t = 1/4, 1/3 and 1/2 exactly

// One straight span along +E, three girders 8 ft apart. Girder 1 gives the
// midspan only (uniform load curve), girder 2 adds a quarter span value and
// girder 3 a third span value, so all three fitting cases are covered.
const GIRDERS = [
  { girder: 1, n: 0, mid: -2.0, quarter: null, third: null },
  { girder: 2, n: 8, mid: -2.5, quarter: -1.9, third: null },
  { girder: 3, n: 16, mid: -1.5, quarter: null, third: -1.3 },
];
const SPAN_START_E = 0;
const SPAN_END_E = 100;

// Planar top of deck, so the TIN interpolates it exactly anywhere.
const deckZ = (e, n) => 108 + 0.005 * e + 0.02 * n;

function workbookRows() {
  const header = [
    "Span number", "Girder number", "Girder width (ft)", "Girder height (ft)", "Camber at midspan (in)",
    "Deflection at midspan (in) [required]", "Deflection at quarter span (in) [optional]",
    "Deflection at third span (in) [optional]", "Support1 Northing (ft)", "Support1 Easting (ft)",
    "Support1 Seat Z (ft)", "Bearing height at Support1 (in)", "Plate height at Support1 (in)",
    "Support2 Northing (ft)", "Support2 Easting (ft)", "Support2 Seat Z (ft)", "Bearing height at Support2 (in)",
    "Plate height at Support2 (in)", "Centerline radius (ft) [optional, 0=straight, +CW, -CCW]",
  ];
  const rows = GIRDERS.map((g) => [
    1, g.girder, 2, 6, 1.5, g.mid, g.quarter ?? "", g.third ?? "",
    g.n, SPAN_START_E, 100, 3, 1, g.n, SPAN_END_E, 100.5, 3, 1, 0,
  ]);
  return [header, ...rows];
}

function landXml() {
  const points = [];
  const faces = [];
  const es = [];
  const ns = [];
  for (let e = -4; e <= 104; e += 4) es.push(e);
  for (let n = -6; n <= 22; n += 2) ns.push(n);
  const id = (i, j) => i * ns.length + j + 1;
  es.forEach((e, i) =>
    ns.forEach((n, j) => points.push(`<P id="${id(i, j)}">${n} ${e} ${deckZ(e, n).toFixed(6)}</P>`)),
  );
  for (let i = 0; i < es.length - 1; i += 1) {
    for (let j = 0; j < ns.length - 1; j += 1) {
      faces.push(`<F>${id(i, j)} ${id(i + 1, j)} ${id(i + 1, j + 1)}</F>`);
      faces.push(`<F>${id(i, j)} ${id(i + 1, j + 1)} ${id(i, j + 1)}</F>`);
    }
  }
  return (
    '<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">' +
    '<Units><Imperial linearUnit="USSurveyFoot" areaUnit="squareFoot" volumeUnit="cubicYard"/></Units>' +
    '<Surfaces><Surface name="Test ToD"><Definition surfType="TIN">' +
    `<Pnts>${points.join("")}</Pnts><Faces>${faces.join("")}</Faces>` +
    "</Definition></Surface></Surfaces></LandXML>"
  );
}

/**
 * Expected deflection (in) at fraction t, worked out independently of app.js:
 * the uniform load elastic curve d = Δmid·(16/5)(u + u²), u = t(1 − t), when
 * only the midspan is given; with one extra observation, the curve
 * d = a1·u + a2·u² through both the midspan and that observation.
 */
function expectedDeflectionIn(g, t) {
  const u = t * (1 - t);
  const extra = g.quarter !== null ? { t: 0.25, value: g.quarter } : g.third !== null ? { t: 1 / 3, value: g.third } : null;
  if (!extra) return g.mid * (16 / 5) * (u + u * u);
  // Solve a1·um + a2·um² = mid and a1·ux + a2·ux² = value.
  const um = 0.25;
  const ux = extra.t * (1 - extra.t);
  const det = um * ux * ux - um * um * ux;
  const a1 = (g.mid * ux * ux - um * um * extra.value) / det;
  const a2 = (um * extra.value - ux * g.mid) / det;
  return a1 * u + a2 * u * u;
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

let flask;
let browser;
let baseUrl;

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  flask = spawn("python", ["-c", `from app import app; app.run(host="127.0.0.1", port=${port})`], {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/bridge/api/health`)).ok) break;
    } catch {
      if (attempt > 100) throw new Error("Flask app did not start");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  flask?.kill();
});

test("deflected deck minus original deck equals the girder deflection at the girder points", async () => {
  const page = await browser.newPage();
  page.on("dialog", (dialog) => {
    throw new Error(`Unexpected alert: ${dialog.message()}`);
  });
  await page.goto(`${baseUrl}/bridge/`);

  // Upload both files through the page's own inputs, built in the page so the
  // workbook goes through the same SheetJS reader as a user's upload.
  await page.evaluate(
    async ({ rows, xml, intervals }) => {
      const upload = async (input, file) => {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event("change"));
      };
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Input");
      const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
      await upload(document.getElementById("fileInput"), new File([bytes], "girders.xlsx"));
      await upload(document.getElementById("dtmFileInput"), new File([xml], "deck.xml", { type: "text/xml" }));
      const intervalsInput = document.getElementById("intervalsInput");
      intervalsInput.value = String(intervals);
      intervalsInput.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { rows: workbookRows(), xml: landXml(), intervals: INTERVALS },
  );
  await page.waitForFunction(() => state.sourceRows.length === 3 && state.dtmTin !== null);

  await page.click("#calculateBtn");
  await page.waitForFunction(() => Object.keys(state.profiles).length === 3);
  await page.click("#tabExportBtn");
  await page.click("#computeDeckBtn");
  await page.waitForFunction(() => state.deflectedDeck !== null);

  const result = await page.evaluate(() => ({
    girderPoints: state.deflectedDeck.girderPoints,
    profiles: state.profiles,
  }));

  let checked = 0;
  const report = [];
  for (const g of GIRDERS) {
    const key = `1||${g.girder}`;
    const points = result.girderPoints[key];
    assert.ok(points, `girder ${g.girder} has deflected deck points`);
    // Every interval, left and right edge of the girder.
    assert.equal(points.length, 2 * (INTERVALS + 1), `girder ${g.girder} point count`);

    for (const point of points) {
      const t = point.interval / INTERVALS;
      const expectedFt = expectedDeflectionIn(g, t) / 12;
      const profileFt = result.profiles[key][point.interval].deflectionIn / 12;
      const difference = point.deflectedZ - point.originalZ;

      assert.ok(Math.abs(point.originalZ - deckZ(point.e, point.n)) < TOLERANCE_FT, `${point.code} original deck`);
      assert.ok(Math.abs(difference - profileFt) < TOLERANCE_FT, `${point.code}: ${difference} vs profile ${profileFt}`);
      assert.ok(Math.abs(difference - expectedFt) < TOLERANCE_FT, `${point.code}: ${difference} vs expected ${expectedFt}`);
      checked += 1;
      if (point.side === "L" && [0, 3, 4, 6].includes(point.interval)) {
        report.push(
          `${point.code}  original ${point.originalZ.toFixed(4)}  deflected ${point.deflectedZ.toFixed(4)}  ` +
            `diff ${(difference * 12).toFixed(4)} in  computed ${(expectedFt * 12).toFixed(4)} in`,
        );
      }
    }

    // The input values are reproduced exactly at their stations.
    const at = (interval) => points.find((point) => point.interval === interval && point.side === "L");
    const inches = (point) => (point.deflectedZ - point.originalZ) * 12;
    assert.ok(Math.abs(inches(at(0))) < 1e-9, "zero at support 1");
    assert.ok(Math.abs(inches(at(INTERVALS))) < 1e-9, "zero at support 2");
    assert.ok(Math.abs(inches(at(INTERVALS / 2)) - g.mid) < 1e-9, "midspan input");
    if (g.quarter !== null) assert.ok(Math.abs(inches(at(INTERVALS / 4)) - g.quarter) < 1e-9, "quarter span input");
    if (g.third !== null) assert.ok(Math.abs(inches(at(INTERVALS / 3)) - g.third) < 1e-9, "third span input");
  }

  console.log(`Checked ${checked} girder points.\n${report.join("\n")}`);
  await page.close();
});
