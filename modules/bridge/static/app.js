const HELP_TEXT = `1. Data & Calculation Tab:
   - Download Template to get the input Excel format.
   - Upload the completed "Girder Data sheet" file.
   - Review imported rows in the editable grid and adjust values before calculation.
   - Set "Centerline radius (ft)" per girder: 0 or blank means straight, positive is clockwise, negative is counterclockwise (from Support1 to Support2).
   - Set the number of intervals and choose Calculate.
   - Export Top of Girder Points once you are satisfied with the results (a separate
     step from calculating, so you can re-run the calculation without re-downloading).
   - The Calculation Log is displayed in this same tab and can be downloaded.

2. Graphs Tab:
   - Includes synchronized Deflection Profile and Plan View plots.
   - The plan uses Northing (N) and Easting (E) as coordinates.
   - Select Span/Girder from the selectors or click a girder in plan view.
   - Selected girder is highlighted, and the profile updates automatically.

3. Deflected Deck Tab:
   - Upload the theoretical (undeflected) top-of-deck DTM as a LandXML surface.
   - Compute Deflected Deck builds an isopach surface from the girder deflections and
     adds it to each DTM point: Deflected Z = DTM Z + isopach.
   - Deck overhangs hold the deflection of the exterior girder they cantilever from, so
     the deck keeps its cross slope across the overhang.
   - Overhang offset (ft) is the distance from the exterior girder centerline to the deck
     edge, measured square to the girder. Leave it blank to use the adjacent girder spacing.
     Deck points beyond the overhang edge, or past the span ends, have no isopach data and
     keep their DTM elevation, so set the offset to reach at least the deck edge.
   - The plan view shows the deck outline, all girders, and the overhang edges (dashed).
     Pick a Span/Girder to highlight it and label the deflected elevations along it; every
     point shows values on hover.
   - Export Top of Deck Deflected points writes N, E, deflected elevation, description,
     original elevation, and the isopach value applied.

4. Notes:
   - Deflection at midspan is required.
   - Deflection at quarter-span and third-span are optional.
   - Ensure all files use the same coordinate system.

For further assistance, please reach out to Rafa Ramirez.`;

const TEMPLATE_HEADERS = [
  "Span number",
  "Girder number",
  "Girder width (ft)",
  "Girder height (ft)",
  "Camber at midspan (in)",
  "Deflection at midspan (in) [required]",
  "Deflection at quarter span (in) [optional]",
  "Deflection at third span (in) [optional]",
  "Support1 Northing (ft)",
  "Support1 Easting (ft)",
  "Support1 Seat Z (ft)",
  "Bearing height at Support1 (in)",
  "Plate height at Support1 (in)",
  "Support2 Northing (ft)",
  "Support2 Easting (ft)",
  "Support2 Seat Z (ft)",
  "Bearing height at Support2 (in)",
  "Plate height at Support2 (in)",
  "Centerline radius (ft) [optional, 0=straight, +CW, -CCW]",
];

// Two-line on-screen rendering of TEMPLATE_HEADERS: the concept on top,
// unit + required/optional together on the bottom -- keeps columns narrow
// without losing information. Parallel array, same length/order as
// TEMPLATE_HEADERS (which stays unabbreviated for the downloaded template
// workbook). The full "0=straight, +CW, -CCW" note is dropped from the
// on-screen column since it is already covered in the Help modal.
const GRID_HEADER_DISPLAY = [
  { concept: "Span number" },
  { concept: "Girder number" },
  { concept: "Girder width", meta: "(ft)" },
  { concept: "Girder height", meta: "(ft)" },
  { concept: "Camber at 1/2 span", meta: "(in)" },
  { concept: "Deflection at 1/2 span", meta: "(in) [required]" },
  { concept: "Deflection at 1/4 span", meta: "(in) [optional]" },
  { concept: "Deflection at 1/3 span", meta: "(in) [optional]" },
  { concept: "Support1 Northing", meta: "(ft)" },
  { concept: "Support1 Easting", meta: "(ft)" },
  { concept: "Support1 Seat Z", meta: "(ft)" },
  { concept: "Bearing height at Support1", meta: "(in)" },
  { concept: "Plate height at Support1", meta: "(in)" },
  { concept: "Support2 Northing", meta: "(ft)" },
  { concept: "Support2 Easting", meta: "(ft)" },
  { concept: "Support2 Seat Z", meta: "(ft)" },
  { concept: "Bearing height at Support2", meta: "(in)" },
  { concept: "Plate height at Support2", meta: "(in)" },
  { concept: "Centerline radius", meta: "(ft) [optional]" },
];

// Shared across every Plotly chart so the modebar (zoom/pan/reset/download)
// behaves identically everywhere.
const PLOTLY_CONFIG = { responsive: true, displaylogo: false };

const state = {
  sourceRows: [],
  topOfGirderPoints: [],
  profiles: {},
  spanToGirders: {},
  girderGeometry: {},
  logs: [],
  dtm: null,
  isopachMesh: null,
  deflectedDeck: null,
};

const ui = {
  helpText: document.getElementById("helpText"),
  tabDataBtn: document.getElementById("tabDataBtn"),
  tabGraphsBtn: document.getElementById("tabGraphsBtn"),
  tabExportBtn: document.getElementById("tabExportBtn"),
  panelData: document.getElementById("panelData"),
  panelGraphs: document.getElementById("panelGraphs"),
  panelExport: document.getElementById("panelExport"),
  sourceTableHead: document.getElementById("sourceTableHead"),
  sourceTableBody: document.getElementById("sourceTableBody"),
  fileInput: document.getElementById("fileInput"),
  dtmFileInput: document.getElementById("dtmFileInput"),
  uploadStatus: document.getElementById("uploadStatus"),
  dtmUploadStatus: document.getElementById("dtmUploadStatus"),
  intervalsInput: document.getElementById("intervalsInput"),
  progressBar: document.getElementById("progressBar"),
  progressText: document.getElementById("progressText"),
  logOutput: document.getElementById("logOutput"),
  graphSpanSelect: document.getElementById("graphSpanSelect"),
  graphGirderSelect: document.getElementById("graphGirderSelect"),
  profileChart: document.getElementById("profileChart"),
  planChart: document.getElementById("planChart"),
  deckSpanSelect: document.getElementById("deckSpanSelect"),
  deckGirderSelect: document.getElementById("deckGirderSelect"),
  deckChart: document.getElementById("deckChart"),
  deckStatus: document.getElementById("deckStatus"),
  overhangInput: document.getElementById("overhangInput"),
};

function setProgress(percent, text) {
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  ui.progressBar.style.width = `${safe}%`;
  ui.progressBar.textContent = `${safe}%`;
  ui.progressBar.setAttribute("aria-valuenow", String(safe));
  ui.progressText.textContent = text;
}

function formatSpan(spanRaw) {
  const text = String(spanRaw ?? "").trim();
  return /^\d+$/.test(text) ? text.padStart(2, "0") : text;
}

function formatGirder(girderRaw) {
  const text = String(girderRaw ?? "").trim();
  return /^\d+$/.test(text) ? text.padStart(2, "0") : text;
}

function formatInterval(index) {
  return String(index).padStart(2, "0");
}

function parseNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeAngle(angle) {
  let output = angle;
  while (output <= -Math.PI) output += 2 * Math.PI;
  while (output > Math.PI) output -= 2 * Math.PI;
  return output;
}

function buildCenterlineGeometry(support1E, support1N, support2E, support2N, radiusRaw) {
  const dE = support2E - support1E;
  const dN = support2N - support1N;
  const chordLength = Math.hypot(dE, dN);
  const signedRadius = parseNumber(radiusRaw, 0);

  if (chordLength <= 1e-12 || Math.abs(signedRadius) <= 1e-12) {
    return {
      isCurved: false,
      signedRadius: 0,
      length: chordLength,
      at(t) {
        const centerE = support1E + t * dE;
        const centerN = support1N + t * dN;
        const tangentE = chordLength > 1e-12 ? dE / chordLength : 1;
        const tangentN = chordLength > 1e-12 ? dN / chordLength : 0;
        return { centerE, centerN, tangentE, tangentN, station: chordLength * t };
      },
    };
  }

  const radius = Math.abs(signedRadius);
  const halfChord = chordLength / 2;
  if (radius + 1e-9 < halfChord) {
    throw new Error(`Invalid centerline radius ${signedRadius}: |radius| must be at least ${halfChord.toFixed(3)} ft for this girder length.`);
  }

  const midpointE = (support1E + support2E) / 2;
  const midpointN = (support1N + support2N) / 2;
  const rightUnitE = dN / chordLength;
  const rightUnitN = -dE / chordLength;
  const side = signedRadius > 0 ? 1 : -1;
  const centerOffset = Math.sqrt(Math.max(0, radius * radius - halfChord * halfChord));
  const circleCenterE = midpointE + side * centerOffset * rightUnitE;
  const circleCenterN = midpointN + side * centerOffset * rightUnitN;

  const thetaStart = Math.atan2(support1N - circleCenterN, support1E - circleCenterE);
  const thetaEndRaw = Math.atan2(support2N - circleCenterN, support2E - circleCenterE);
  let delta = normalizeAngle(thetaEndRaw - thetaStart);
  if (side > 0 && delta > 0) delta -= 2 * Math.PI;
  if (side < 0 && delta < 0) delta += 2 * Math.PI;

  const arcLength = Math.abs(delta) * radius;

  return {
    isCurved: true,
    signedRadius,
    length: arcLength,
    at(t) {
      const theta = thetaStart + delta * t;
      const centerE = circleCenterE + radius * Math.cos(theta);
      const centerN = circleCenterN + radius * Math.sin(theta);
      const tangentScale = delta >= 0 ? 1 : -1;
      const tangentE = tangentScale * -Math.sin(theta);
      const tangentN = tangentScale * Math.cos(theta);
      return { centerE, centerN, tangentE, tangentN, station: arcLength * t };
    },
  };
}

function computeParabolaA(observations) {
  if (!observations.length) return 0;
  const basis = (t) => t * t - t;
  if (observations.length === 1) {
    const b = basis(observations[0].t);
    return Math.abs(b) < 1e-12 ? 0 : observations[0].value / b;
  }

  let numerator = 0;
  let denominator = 0;
  observations.forEach((obs) => {
    const b = basis(obs.t);
    numerator += obs.value * b;
    denominator += b * b;
  });

  return Math.abs(denominator) < 1e-12 ? 0 : numerator / denominator;
}

function activateTab(tab) {
  const isData = tab === "data";
  const isGraphs = tab === "graphs";

  ui.panelData.classList.toggle("d-none", !isData);
  ui.panelGraphs.classList.toggle("d-none", !isGraphs);
  ui.panelExport.classList.toggle("d-none", tab !== "export");

  ui.tabDataBtn.classList.toggle("active", isData);
  ui.tabGraphsBtn.classList.toggle("active", isGraphs);
  ui.tabExportBtn.classList.toggle("active", tab === "export");

  if (isGraphs) {
    renderProfileChart();
    renderPlanChart();
  }

  if (tab === "export") {
    renderDeflectedDeckChart();
  }
}

function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadTemplate() {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Template");
  const output = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  const url = URL.createObjectURL(new Blob([output], { type: "application/octet-stream" }));
  triggerDownload(url, "Data_Input Template.xlsx");
}

function readWorkbook(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const bytes = new Uint8Array(event.target.result);
        resolve(XLSX.read(bytes, { type: "array" }));
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error("Failed to read the selected file."));
    reader.readAsArrayBuffer(file);
  });
}

function normalizeRow(row) {
  const result = Array.from({ length: TEMPLATE_HEADERS.length }, (_, i) => row?.[i] ?? "");
  return result;
}

function renderSourceGrid() {
  ui.sourceTableHead.innerHTML = `<tr>${GRID_HEADER_DISPLAY.map(
    ({ concept, meta }) =>
      `<th><span class="grid-th-concept">${concept}</span>${
        meta ? `<span class="grid-th-meta">${meta}</span>` : ""
      }</th>`,
  ).join("")}</tr>`;

  if (!state.sourceRows.length) {
    ui.sourceTableBody.innerHTML = `<tr><td colspan="${TEMPLATE_HEADERS.length}" class="text-center text-secondary py-3">Upload a spreadsheet to view/edit rows.</td></tr>`;
    return;
  }

  ui.sourceTableBody.innerHTML = "";
  state.sourceRows.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    TEMPLATE_HEADERS.forEach((_, colIndex) => {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.className = "grid-cell";
      input.value = row[colIndex] ?? "";
      input.addEventListener("input", (event) => {
        state.sourceRows[rowIndex][colIndex] = event.target.value;
      });
      td.appendChild(input);
      tr.appendChild(td);
    });
    ui.sourceTableBody.appendChild(tr);
  });
}

async function loadSourceRows() {
  const [file] = ui.fileInput.files;
  if (!file) {
    state.sourceRows = [];
    ui.uploadStatus.textContent = "";
    renderSourceGrid();
    return;
  }

  const workbook = await readWorkbook(file);
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  state.sourceRows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 }).slice(1).map(normalizeRow);
  ui.uploadStatus.textContent = "Spreadsheet uploaded correctly. You can edit values in the grid before calculation.";
  renderSourceGrid();
}

function buildGirderPoints(row, intervals) {
  const spanRaw = row[0];
  const girderRaw = row[1];
  const spanDisplay = String(spanRaw ?? "").trim();
  const girderDisplay = String(girderRaw ?? "").trim();

  const girderWidth = parseNumber(row[2]);
  const girderHeight = parseNumber(row[3]);
  const camberMid = parseNumber(row[4]);
  const defMid = parseNumber(row[5], Number.NaN);
  const defQuarter = parseNumber(row[6], Number.NaN);
  const defThird = parseNumber(row[7], Number.NaN);

  const support1N = parseNumber(row[8]);
  const support1E = parseNumber(row[9]);
  const support1Z = parseNumber(row[10]);
  const support1Bearing = parseNumber(row[11]);
  const support1Plate = parseNumber(row[12]);
  const support2N = parseNumber(row[13]);
  const support2E = parseNumber(row[14]);
  const support2Z = parseNumber(row[15]);
  const support2Bearing = parseNumber(row[16]);
  const support2Plate = parseNumber(row[17]);
  const centerlineRadius = parseNumber(row[18], 0);

  if (!spanDisplay || !girderDisplay || !Number.isFinite(defMid)) {
    throw new Error("Span, Girder, and Deflection at midspan are required in each row.");
  }

  const observations = [];
  if (Number.isFinite(defQuarter)) observations.push({ t: 0.25, value: defQuarter });
  if (Number.isFinite(defThird)) observations.push({ t: 1 / 3, value: defThird });
  observations.push({ t: 0.5, value: defMid });

  const aDefIn = computeParabolaA(observations);
  const aCamberIn = -4 * camberMid;

  const bearingFeet1 = support1Bearing / 12;
  const plateFeet1 = support1Plate / 12;
  const bearingFeet2 = support2Bearing / 12;
  const plateFeet2 = support2Plate / 12;

  const centerline = buildCenterlineGeometry(support1E, support1N, support2E, support2N, centerlineRadius);

  const rows = [];
  const graphPoints = [];
  const planCenterline = [];

  for (let i = 0; i <= intervals; i += 1) {
    const t = i / intervals;
    const geometryPoint = centerline.at(t);
    const centerN = geometryPoint.centerN;
    const centerE = geometryPoint.centerE;

    const seatZ = support1Z + t * (support2Z - support1Z);
    const bearing = bearingFeet1 + t * (bearingFeet2 - bearingFeet1);
    const plate = plateFeet1 + t * (plateFeet2 - plateFeet1);

    const deflectionIn = aDefIn * (t * t - t);
    const camberIn = aCamberIn * (t * t - t);
    const deflectionFt = deflectionIn / 12;
    const camberFt = camberIn / 12;

    const elevation = seatZ + bearing + plate + girderHeight + deflectionFt;

    const halfWidth = girderWidth / 2;
    const perpendicularE = -geometryPoint.tangentN;
    const perpendicularN = geometryPoint.tangentE;
    const leftN = centerN + perpendicularN * halfWidth;
    const leftE = centerE + perpendicularE * halfWidth;
    const rightN = centerN - perpendicularN * halfWidth;
    const rightE = centerE - perpendicularE * halfWidth;

    const base = `${formatSpan(spanRaw)}${formatGirder(girderRaw)}${formatInterval(i)}`;
    rows.push([leftN, leftE, elevation, `${base}L`, deflectionFt, camberFt]);
    rows.push([rightN, rightE, elevation, `${base}R`, deflectionFt, camberFt]);

    graphPoints.push({
      station: geometryPoint.station,
      deflectionIn,
      interval: i,
      t,
    });

    planCenterline.push({ n: centerN, e: centerE });
  }

  return {
    spanDisplay,
    girderDisplay,
    aDefIn,
    aCamberIn,
    support1N,
    support1E,
    support2N,
    support2E,
    centerlineRadius,
    centerlineCurved: centerline.isCurved,
    planCenterline,
    rows,
    graphPoints,
  };
}

function exportRowsAsWorkbook(rows, name) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, "Results");
  const output = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  const url = URL.createObjectURL(new Blob([output], { type: "application/octet-stream" }));
  triggerDownload(url, name);
}

function sortedSpans() {
  return Object.keys(state.spanToGirders).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function sortedGirders(spanValue) {
  return Array.from(state.spanToGirders[spanValue] ?? []).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

function populateGirderSelect(spanValue, selectEl) {
  if (!selectEl) return;

  const girders = sortedGirders(spanValue);
  if (!girders.length) {
    selectEl.innerHTML = '<option value="">(No girders found)</option>';
    selectEl.disabled = true;
    return;
  }

  const previous = selectEl.value;
  selectEl.disabled = false;
  selectEl.innerHTML = "";
  girders.forEach((girder) => {
    const option = document.createElement("option");
    option.value = girder;
    option.textContent = girder;
    selectEl.appendChild(option);
  });
  selectEl.value = girders.includes(previous) ? previous : girders[0];
}

function populateSpanGirderPair(spanSelect, girderSelect) {
  if (!spanSelect || !girderSelect) return;

  const spans = sortedSpans();
  if (!spans.length) {
    spanSelect.innerHTML = '<option value="">(Run calculation first)</option>';
    girderSelect.innerHTML = '<option value="">(Run calculation first)</option>';
    spanSelect.disabled = true;
    girderSelect.disabled = true;
    return;
  }

  const previous = spanSelect.value;
  spanSelect.disabled = false;
  spanSelect.innerHTML = "";
  spans.forEach((span) => {
    const option = document.createElement("option");
    option.value = span;
    option.textContent = span;
    spanSelect.appendChild(option);
  });

  spanSelect.value = spans.includes(previous) ? previous : spans[0];
  populateGirderSelect(spanSelect.value, girderSelect);
}

function populateGraphSelectors() {
  populateSpanGirderPair(ui.graphSpanSelect, ui.graphGirderSelect);
  populateSpanGirderPair(ui.deckSpanSelect, ui.deckGirderSelect);
}

function renderProfileChart() {
  const span = ui.graphSpanSelect.value;
  const girder = ui.graphGirderSelect.value;
  if (!span || !girder) return;

  const key = `${span}||${girder}`;
  const profile = state.profiles[key];
  if (!profile?.length) return;

  const x = profile.map((point) => point.station);
  const y = profile.map((point) => Math.abs(point.deflectionIn));

  Plotly.newPlot(
    ui.profileChart,
    [
      {
        x,
        y,
        mode: "lines+markers",
        hovertemplate: "Interval %{customdata[0]}<br>Station = %{x:.2f} ft<br>Deflection = %{customdata[1]:.3f} in<extra></extra>",
        customdata: profile.map((point) => [point.interval, point.deflectionIn]),
        line: { width: 3, color: "#0d6efd" },
        marker: { size: 8, color: "#0d6efd" },
      },
    ],
    {
      title: `<b>Span ${span} — Girder ${girder}</b>`,
      xaxis: { title: "Length along girder (ft)", zeroline: false },
      yaxis: { title: "Deflection (in)" },
      margin: { t: 60, r: 25, b: 60, l: 60 },
      paper_bgcolor: "#fcfdff",
      plot_bgcolor: "#fcfdff",
      showlegend: false,
    },
    PLOTLY_CONFIG,
  );
}

function getPowerOfTenTickStep(minValue, maxValue) {
  const range = Math.max(0, Math.abs(maxValue - minValue));
  if (range <= 0) return 1;
  const approx = range / 8;
  const exponent = Math.round(Math.log10(Math.max(1, approx)));
  return 10 ** exponent;
}

function renderPlanChart() {
  const span = ui.graphSpanSelect.value;
  const selectedGirder = ui.graphGirderSelect.value;
  const spans = Object.keys(state.spanToGirders).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!spans.length) return;

  const traces = spans
    .flatMap((spanValue) => {
      const girders = Array.from(state.spanToGirders[spanValue] ?? []).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return girders.map((girder) => {
        const key = `${spanValue}||${girder}`;
        const geo = state.girderGeometry[key];
        if (!geo) return null;
        const isSelected = spanValue === span && girder === selectedGirder;
        return {
          x: geo.planCenterline.map((point) => point.e),
          y: geo.planCenterline.map((point) => point.n),
          mode: "lines+markers",
          line: {
            width: isSelected ? 6 : 3,
            color: isSelected ? "#d63384" : "#6c757d",
          },
          marker: { size: isSelected ? 10 : 7 },
          name: `Span ${spanValue} — Girder ${girder}`,
          customdata: [[spanValue, girder], [spanValue, girder]],
          hovertemplate: `Span ${spanValue}<br>Girder ${girder}<extra></extra>`,
        };
      });
    })
    .filter(Boolean);
  if (!traces.length) return;

  Plotly.newPlot(
    ui.planChart,
    traces,
    {
      title: "<b>Plan View for All Spans (N/E)</b>",
      xaxis: {
        title: { text: "Easting (ft)", standoff: 34 },
        dtick: getPowerOfTenTickStep(
          Math.min(...traces.flatMap((t) => t.x)),
          Math.max(...traces.flatMap((t) => t.x)),
        ),
        tickformat: ".0f",
        exponentformat: "none",
        showexponent: "none",
        tickangle: -45,
        nticks: 10,
        automargin: true,
      },
      yaxis: {
        title: { text: "Northing (ft)", standoff: 14 },
        scaleanchor: "x",
        scaleratio: 1,
        dtick: getPowerOfTenTickStep(
          Math.min(...traces.flatMap((t) => t.y)),
          Math.max(...traces.flatMap((t) => t.y)),
        ),
        tickformat: ".0f",
        exponentformat: "none",
        showexponent: "none",
        nticks: 10,
        automargin: true,
      },
      margin: { t: 60, r: 25, b: 115, l: 95 },
      paper_bgcolor: "#fcfdff",
      plot_bgcolor: "#fcfdff",
      showlegend: false,
    },
    PLOTLY_CONFIG,
  );
}


function logLine(message) {
  state.logs.push(message);
  ui.logOutput.textContent = state.logs.join("\n");
}

function minMax(values) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return values.length ? { min, max } : null;
}

function girderPlanBounds() {
  const points = [];
  Object.values(state.girderGeometry).forEach((geometry) => {
    (geometry?.planCenterline ?? []).forEach((point) => points.push(point));
  });
  return points.length ? BridgeLandXml.boundsOf(points) : null;
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target.result);
    reader.onerror = () => reject(new Error("Failed to read the selected file."));
    reader.readAsText(file);
  });
}

async function loadDtmSurface() {
  const [file] = ui.dtmFileInput.files;
  state.deflectedDeck = null;

  if (!file) {
    state.dtm = null;
    ui.dtmUploadStatus.textContent = "";
    renderDeflectedDeckChart();
    return;
  }

  const { surfaces } = BridgeLandXml.parseLandXml(await readTextFile(file));
  const surface = surfaces[0];
  state.dtm = surface;

  ui.dtmUploadStatus.textContent = `Loaded "${surface.name}" - ${surface.points.length} points, ${surface.faces.length} faces.`;
  logLine(
    `DTM: loaded surface "${surface.name}" with ${surface.points.length} points and ${surface.faces.length} faces.`,
  );
  if (surfaces.length > 1) {
    logLine(`DTM: file contains ${surfaces.length} surfaces; using the first ("${surface.name}").`);
  }

  const bounds = girderPlanBounds();
  if (bounds && BridgeLandXml.detectSwappedAxes(surface.bounds, bounds)) {
    logLine(
      "DTM WARNING: surface coordinates only overlap the girders when N and E are swapped. " +
        "Check the exporter's axis order before trusting the result.",
    );
  }

  renderDeflectedDeckChart();
}

/** Blank means "use the girder spacing"; returns null in that case. */
function readOverhangOffset() {
  const raw = String(ui.overhangInput?.value ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Overhang offset must be a number of feet, 0 or greater (or blank to use the girder spacing).");
  }
  return value > 0 ? value : null;
}

function getDeckOutlineRings() {
  const surface = state.dtm;
  if (!surface) return [];

  const outer = surface.boundaries.filter((boundary) => boundary.type !== "island" && boundary.type !== "hole");
  if (outer.length) return outer.map((boundary) => boundary.points);

  if (surface.faces.length) {
    const rings = BridgeLandXml.extractBoundaryRings(surface.points, surface.faces);
    if (rings.length) return rings;
  }

  const hull = BridgeIsopach.convexHull(surface.points);
  return hull.length >= 3 ? [hull] : [];
}

function logDeckReferenceStats() {
  const deckZ = minMax(state.dtm.points.map((point) => point.z));
  const isopach = minMax(state.deflectedDeck.points.map((point) => point.isopach));

  const undeflectedGirderZ = [];
  for (let i = 1; i < state.topOfGirderPoints.length; i += 1) {
    const row = state.topOfGirderPoints[i];
    undeflectedGirderZ.push(row[2] - row[4]);
  }
  const girderZ = minMax(undeflectedGirderZ);

  if (deckZ) logLine(`QC: DTM deck elevation range ${deckZ.min.toFixed(3)} to ${deckZ.max.toFixed(3)} ft.`);
  if (girderZ) {
    logLine(
      `QC: undeflected top-of-girder range ${girderZ.min.toFixed(3)} to ${girderZ.max.toFixed(3)} ft ` +
        "(deck should sit above this by the haunch + slab thickness).",
    );
  }
  if (isopach) logLine(`QC: isopach applied ranges ${isopach.min.toFixed(3)} to ${isopach.max.toFixed(3)} ft.`);

  if (deckZ && girderZ && deckZ.max < girderZ.min) {
    logLine(
      "QC WARNING: the entire DTM sits below the top of girder. The uploaded surface is probably not the " +
        "theoretical top of deck (or the units/datum differ), so the deflected elevations will be wrong.",
    );
  }
}

function computeDeflectedDeck() {
  if (!state.topOfGirderPoints.length) {
    window.alert("Please calculate the top-of-girder points first (Girder Calcs tab).");
    return false;
  }
  if (!state.dtm) {
    window.alert("Please upload the top-of-deck DTM XML surface first.");
    return false;
  }

  let overhangOffset;
  try {
    overhangOffset = readOverhangOffset();
  } catch (error) {
    window.alert(error.message);
    return false;
  }

  const mesh = BridgeIsopach.buildIsopachMesh({
    spanToGirders: state.spanToGirders,
    girderGeometry: state.girderGeometry,
    profiles: state.profiles,
    overhangOffset,
  });
  mesh.warnings.forEach((warning) => logLine(`Isopach WARNING: ${warning}`));
  logLine(
    overhangOffset === null
      ? "Isopach: overhang edge set one girder spacing outside the exterior girders (no overhang offset given)."
      : `Isopach: overhang edge set ${overhangOffset.toFixed(3)} ft outside the exterior girder centerlines.`,
  );

  if (!mesh.triangleCount) {
    window.alert("The isopach surface is empty. At least one span needs two or more girders.");
    return false;
  }

  const girderBounds = girderPlanBounds();
  const deckBounds = state.dtm.bounds;
  const overlaps =
    girderBounds &&
    deckBounds &&
    girderBounds.minE <= deckBounds.maxE &&
    deckBounds.minE <= girderBounds.maxE &&
    girderBounds.minN <= deckBounds.maxN &&
    deckBounds.minN <= girderBounds.maxN;

  if (!overlaps) {
    logLine("Deflected deck ERROR: DTM extents do not overlap the girder extents; nothing was computed.");
    window.alert(
      "The DTM surface does not overlap the girder footprint. Confirm both files use the same coordinate system.",
    );
    return false;
  }

  const points = state.dtm.points.map((point) => {
    const hit = mesh.sample(point.e, point.n);
    const isopach = hit ? hit.value : 0;
    return {
      id: point.id,
      name: point.name,
      n: point.n,
      e: point.e,
      originalZ: point.z,
      isopach,
      deflectedZ: point.z + isopach,
      spanKey: hit ? hit.spanKey : null,
      girderKey: hit ? hit.girderKey : null,
    };
  });

  const inside = points.reduce((total, point) => total + (point.spanKey === null ? 0 : 1), 0);

  // A deck DTM is often built from a few longitudinal feature lines (edges and
  // PGL), so it may have no vertex anywhere near an interior girder. Sample the
  // deflected surface along every girder centerline instead, so each girder has
  // elevations to report regardless of where the DTM happens to place vertices.
  const tin = BridgeIsopach.buildTinInterpolator(state.dtm.points, state.dtm.faces);
  const girderPoints = {};
  let sampledGirders = 0;

  sortedSpans().forEach((span) => {
    sortedGirders(span).forEach((girder) => {
      const key = `${span}||${girder}`;
      const centerline = state.girderGeometry[key]?.planCenterline;
      if (!centerline?.length) return;

      const sampled = [];
      centerline.forEach((point, interval) => {
        const deckZ = tin.sample(point.e, point.n);
        if (deckZ === null) return;
        const hit = mesh.sample(point.e, point.n);
        const isopach = hit ? hit.value : 0;
        sampled.push({
          e: point.e,
          n: point.n,
          interval,
          originalZ: deckZ,
          isopach,
          deflectedZ: deckZ + isopach,
        });
      });

      if (sampled.length) {
        girderPoints[key] = sampled;
        sampledGirders += 1;
      }
    });
  });

  state.isopachMesh = mesh;
  state.deflectedDeck = { points, inside, girderPoints };

  logLine(
    `Deflected deck: ${points.length} DTM points - ${inside} inside the isopach surface, ` +
      `${points.length - inside} outside (isopach held at 0, original elevation kept).`,
  );
  if (tin.triangleCount) {
    logLine(`Deflected deck: sampled deck elevations along ${sampledGirders} girder centerlines for the plan view.`);
  } else {
    logLine(
      "Deflected deck NOTE: the DTM has no TIN faces, so deck elevations could not be sampled along the " +
        "girder centerlines. Only the surface's own points are shown.",
    );
  }
  logDeckReferenceStats();

  renderDeflectedDeckChart();
  return true;
}

/**
 * Samples the isopach on a regular grid clipped to the deck outline, so the
 * deflection field is shown across the whole deck rather than only where the
 * DTM happens to place vertices. Areas past the span ends read 0, which is
 * physically correct -- the deflection parabola is zero at every support.
 */
function buildIsopachHeatmap(rings) {
  const mesh = state.isopachMesh;
  if (!mesh || !rings.length) return null;

  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  rings.forEach((ring) =>
    ring.forEach((point) => {
      if (point.e < minE) minE = point.e;
      if (point.e > maxE) maxE = point.e;
      if (point.n < minN) minN = point.n;
      if (point.n > maxN) maxN = point.n;
    }),
  );

  const width = maxE - minE;
  const height = maxN - minN;
  if (!(width > 0) || !(height > 0)) return null;

  const longest = 220;
  const step = Math.max(width, height) / longest;
  const cols = Math.max(2, Math.ceil(width / step) + 1);
  const rows = Math.max(2, Math.ceil(height / step) + 1);

  const xs = Array.from({ length: cols }, (_, i) => minE + i * step);
  const ys = Array.from({ length: rows }, (_, j) => minN + j * step);
  const z = ys.map((n) =>
    xs.map((e) => {
      if (!BridgeIsopach.pointInRings(e, n, rings)) return null;
      const hit = mesh.sample(e, n);
      return hit ? hit.value : 0;
    }),
  );

  return { x: xs, y: ys, z };
}

function renderDeflectedDeckChart() {
  if (!ui.deckChart) return;

  const selectedSpan = ui.deckSpanSelect?.value ?? "";
  const selectedGirder = ui.deckGirderSelect?.value ?? "";
  const traces = [];
  const outlineRings = getDeckOutlineRings();

  if (state.deflectedDeck) {
    const heatmap = buildIsopachHeatmap(outlineRings);
    if (heatmap) {
      traces.push({
        type: "heatmap",
        x: heatmap.x,
        y: heatmap.y,
        z: heatmap.z,
        colorscale: "YlOrRd",
        // Plotly's YlOrRd runs dark-red -> pale, so reverse it: pale means
        // little or no deflection, deep red means the most.
        reversescale: true,
        zsmooth: "best",
        hoverongaps: false,
        showscale: true,
        // title.side defaults to "top", which sits right in the corner where
        // Plotly's modebar (zoom/pan/reset) floats, hiding it behind the text.
        colorbar: { title: { text: "Deflection (ft)", side: "right" }, thickness: 12, tickformat: ".3f" },
        name: "Deflection",
        hovertemplate: "N %{y:.3f}<br>E %{x:.3f}<br>Deflection %{z:.3f} ft<extra></extra>",
      });
    }
  }

  outlineRings.forEach((ring, index) => {
    if (ring.length < 3) return;
    const closed = ring.concat([ring[0]]);
    traces.push({
      x: closed.map((point) => point.e),
      y: closed.map((point) => point.n),
      mode: "lines",
      line: { width: 2, color: "#212529" },
      name: index === 0 ? "Deck outline" : `Deck outline ${index + 1}`,
      hoverinfo: "skip",
    });
  });

  sortedSpans().forEach((span) => {
    sortedGirders(span).forEach((girder) => {
      const geometry = state.girderGeometry[`${span}||${girder}`];
      if (!geometry?.planCenterline?.length) return;
      const isSelected = span === selectedSpan && girder === selectedGirder;
      traces.push({
        x: geometry.planCenterline.map((point) => point.e),
        y: geometry.planCenterline.map((point) => point.n),
        mode: "lines",
        line: { width: isSelected ? 6 : 3, color: isSelected ? "#d63384" : "#6c757d" },
        name: `Span ${span} - Girder ${girder}`,
        customdata: geometry.planCenterline.map(() => [span, girder]),
        hovertemplate: `Span ${span}<br>Girder ${girder}<extra></extra>`,
      });
    });
  });

  (state.deflectedDeck ? state.isopachMesh?.overhangEdges ?? [] : []).forEach((edge) => {
    traces.push({
      x: edge.points.map((point) => point.e),
      y: edge.points.map((point) => point.n),
      mode: "lines",
      line: { width: 2, color: "#fd7e14", dash: "dash" },
      name: `Span ${edge.span} - overhang edge at Girder ${edge.girder}`,
      hovertemplate: `Span ${edge.span}<br>Overhang edge (Girder ${edge.girder})<extra></extra>`,
    });
  });

  const deck = state.deflectedDeck;
  if (deck) {
    // Plotly's hovertemplate parser does not accept the "+" sign flag, and
    // silently falls back to full precision when it sees one.
    const hover =
      "N %{y:.3f}<br>E %{x:.3f}<br>DTM %{customdata[0]:.3f} ft<br>" +
      "Deflection %{customdata[1]:.3f} ft<br><b>Deflected %{customdata[2]:.3f} ft</b><extra></extra>";
    const toCustomdata = (point) => [point.originalZ, point.isopach, point.deflectedZ];

    traces.push({
      type: "scattergl",
      x: deck.points.map((point) => point.e),
      y: deck.points.map((point) => point.n),
      mode: "markers",
      marker: { size: 4, color: "rgba(33,37,41,0.55)" },
      name: "DTM surface points",
      customdata: deck.points.map(toCustomdata),
      hovertemplate: hover,
    });

    // Deck elevations sampled along the selected girder, labelled in place.
    const selectedPoints = deck.girderPoints?.[`${selectedSpan}||${selectedGirder}`] ?? [];
    if (selectedPoints.length) {
      traces.push({
        x: selectedPoints.map((point) => point.e),
        y: selectedPoints.map((point) => point.n),
        mode: "markers+text",
        marker: { size: 9, color: "#d63384", line: { width: 1, color: "#fff" } },
        // Label with the point code used in the export, so a point on the plan
        // can be matched to its exported row.
        text: selectedPoints.map(
          (point) =>
            `${formatSpan(selectedSpan)}${formatGirder(selectedGirder)}${formatInterval(point.interval)}`,
        ),
        textposition: "top center",
        textfont: { size: 10, color: "#212529" },
        name: `Span ${selectedSpan} - Girder ${selectedGirder}`,
        customdata: selectedPoints.map(toCustomdata),
        hovertemplate:
          "Interval %{pointNumber}<br>" + hover.replace("<extra></extra>", "") + "<extra></extra>",
      });
    }
  }

  if (!traces.length) {
    Plotly.purge(ui.deckChart);
    if (ui.deckStatus) {
      ui.deckStatus.textContent = "Run the girder calculation and upload a DTM to see the deflected deck.";
    }
    return;
  }

  if (ui.deckStatus) {
    if (deck) {
      ui.deckStatus.textContent =
        `${deck.points.length} deflected deck points (${deck.inside} inside the isopach surface, ` +
        `${deck.points.length - deck.inside} keeping their original elevation).`;
    } else if (state.dtm) {
      ui.deckStatus.textContent =
        `"${state.dtm.name}" loaded with ${state.dtm.points.length} points. ` +
        "Choose Compute Deflected Deck to apply the isopach.";
    } else {
      ui.deckStatus.textContent = "Upload a DTM XML surface and choose Compute Deflected Deck.";
    }
  }

  // Spreading into Math.min/max would overflow the argument limit on a large deck.
  const boundsOfTraces = (axis) => {
    let min = Infinity;
    let max = -Infinity;
    traces.forEach((trace) => {
      const values = trace[axis];
      for (let i = 0; i < values.length; i += 1) {
        if (values[i] < min) min = values[i];
        if (values[i] > max) max = values[i];
      }
    });
    return { min, max };
  };
  const xBounds = boundsOfTraces("x");
  const yBounds = boundsOfTraces("y");

  Plotly.newPlot(
    ui.deckChart,
    traces,
    {
      title: "<b>Deflected Deck - Plan View (N/E)</b>",
      xaxis: {
        title: { text: "Easting (ft)", standoff: 34 },
        dtick: getPowerOfTenTickStep(xBounds.min, xBounds.max),
        tickformat: ".0f",
        exponentformat: "none",
        showexponent: "none",
        tickangle: -45,
        nticks: 10,
        automargin: true,
      },
      yaxis: {
        title: { text: "Northing (ft)", standoff: 14 },
        scaleanchor: "x",
        scaleratio: 1,
        dtick: getPowerOfTenTickStep(yBounds.min, yBounds.max),
        tickformat: ".0f",
        exponentformat: "none",
        showexponent: "none",
        nticks: 10,
        automargin: true,
      },
      margin: { t: 60, r: 25, b: 115, l: 95 },
      paper_bgcolor: "#fcfdff",
      plot_bgcolor: "#fcfdff",
      showlegend: false,
    },
    PLOTLY_CONFIG,
  );
}

function runCalculation() {
  if (!state.sourceRows.length) {
    window.alert("Please upload the input Excel file.");
    return;
  }

  const intervals = parseNumber(ui.intervalsInput.value, Number.NaN);
  if (!Number.isInteger(intervals) || intervals < 1 || intervals > 250) {
    window.alert("Intervals must be an integer between 1 and 250.");
    return;
  }

  state.logs = [];
  state.profiles = {};
  state.spanToGirders = {};
  state.girderGeometry = {};
  // Deflections are about to change, so any deck computed from them is stale.
  state.isopachMesh = null;
  state.deflectedDeck = null;

  const output = [["N", "E", "Elevation (ft)", "Description", "Deflection (ft)", "Camber (ft)"]];

  const total = state.sourceRows.length;
  for (let rowIndex = 0; rowIndex < total; rowIndex += 1) {
    const row = normalizeRow(state.sourceRows[rowIndex]);
    state.sourceRows[rowIndex] = row;

    try {
      const result = buildGirderPoints(row, intervals);
      output.push(...result.rows);

      const profileKey = `${result.spanDisplay}||${result.girderDisplay}`;
      state.profiles[profileKey] = result.graphPoints;
      state.girderGeometry[profileKey] = {
        support1N: result.support1N,
        support1E: result.support1E,
        support2N: result.support2N,
        support2E: result.support2E,
        planCenterline: result.planCenterline,
      };

      if (!state.spanToGirders[result.spanDisplay]) {
        state.spanToGirders[result.spanDisplay] = new Set();
      }
      state.spanToGirders[result.spanDisplay].add(result.girderDisplay);

      state.logs.push(
        `Row ${rowIndex + 2}: Span ${result.spanDisplay}, Girder ${result.girderDisplay}. A_def=${result.aDefIn.toFixed(3)} in, A_camber=${result.aCamberIn.toFixed(3)} in, centerline radius=${result.centerlineRadius.toFixed(3)} ft.`,
      );
    } catch (error) {
      state.logs.push(`Row ${rowIndex + 2}: ERROR - ${error.message}`);
    }

    const pct = Math.round(((rowIndex + 1) / total) * 100);
    setProgress(pct, `Processed row ${rowIndex + 1} of ${total}`);
  }

  state.topOfGirderPoints = output;
  ui.logOutput.textContent = state.logs.join("\n");
  populateGraphSelectors();
  renderProfileChart();
  renderPlanChart();
  setProgress(100, "Calculation complete");
}

function exportTopOfGirderPoints() {
  if (state.topOfGirderPoints.length <= 1) {
    window.alert("Please run the calculation first.");
    return;
  }

  exportRowsAsWorkbook(state.topOfGirderPoints, "Top of girder.xlsx");
  logLine(`Export: wrote ${state.topOfGirderPoints.length - 1} top-of-girder points to "Top of girder.xlsx".`);
}

function exportTopOfDeckDeflected() {
  if (!state.topOfGirderPoints.length) {
    window.alert("Please calculate the top-of-girder points first.");
    return;
  }

  if (state.dtm && !state.deflectedDeck && !computeDeflectedDeck()) {
    return;
  }

  if (state.deflectedDeck) {
    const girderPoints = state.deflectedDeck.girderPoints ?? {};
    const rows = [
      ["N", "E", "Deflected Elevation (ft)", "Description", "Deck Elevation (ft)", "Isopach (ft)"],
    ];

    sortedSpans().forEach((span) => {
      sortedGirders(span).forEach((girder) => {
        (girderPoints[`${span}||${girder}`] ?? []).forEach((point) => {
          rows.push([
            point.n,
            point.e,
            point.deflectedZ,
            `${formatSpan(span)}${formatGirder(girder)}${formatInterval(point.interval)}`,
            point.originalZ,
            point.isopach,
          ]);
        });
      });
    });

    if (rows.length === 1) {
      window.alert(
        "No deflected points could be sampled along the girders. The DTM may not have TIN faces, " +
          "or it may not cover the girder lines.",
      );
      return;
    }

    exportRowsAsWorkbook(rows, "ToD Deflected.xlsx");
    logLine(`Export: wrote ${rows.length - 1} deflected deck points at girder intervals to "ToD Deflected.xlsx".`);
    return;
  }

  const projectedRows = [["N", "E", "Elevation (ft)", "Description"]];
  for (let i = 1; i < state.topOfGirderPoints.length; i += 1) {
    const [n, e, elevation, desc] = state.topOfGirderPoints[i];
    projectedRows.push([n, e, elevation, desc]);
  }

  exportRowsAsWorkbook(projectedRows, "ToD Deflected.xlsx");
  logLine(
    "Projection note: No DTM XML provided. Export used computed top-of-girder elevations only (no deck surface applied).",
  );
}

function downloadLog() {
  const blob = new Blob([ui.logOutput.textContent || "No log entries yet."], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, "Log.txt");
}

ui.helpText.textContent = HELP_TEXT;
renderSourceGrid();

ui.tabDataBtn.addEventListener("click", () => activateTab("data"));
ui.tabGraphsBtn.addEventListener("click", () => activateTab("graphs"));
ui.tabExportBtn.addEventListener("click", () => activateTab("export"));

document.getElementById("downloadTemplateBtn").addEventListener("click", downloadTemplate);
document.getElementById("calculateBtn").addEventListener("click", runCalculation);
document.getElementById("exportGirderBtn").addEventListener("click", exportTopOfGirderPoints);
document.getElementById("projectBtn").addEventListener("click", exportTopOfDeckDeflected);
document.getElementById("downloadLogBtn").addEventListener("click", downloadLog);

ui.fileInput.addEventListener("change", async () => {
  try {
    await loadSourceRows();
  } catch (error) {
    state.sourceRows = [];
    renderSourceGrid();
    ui.uploadStatus.textContent = `Error loading spreadsheet: ${error.message}`;
  }
});

ui.dtmFileInput.addEventListener("change", async () => {
  try {
    await loadDtmSurface();
  } catch (error) {
    state.dtm = null;
    state.deflectedDeck = null;
    ui.dtmUploadStatus.textContent = `Error loading DTM: ${error.message}`;
    logLine(`DTM ERROR: ${error.message}`);
    renderDeflectedDeckChart();
  }
});

if (ui.overhangInput) {
  // A new overhang only reshapes the isopach edges, so recompute straight
  // away when a deck is already showing.
  ui.overhangInput.addEventListener("change", () => {
    if (state.deflectedDeck) computeDeflectedDeck();
  });
}

ui.graphSpanSelect.addEventListener("change", () => {
  populateGirderSelect(ui.graphSpanSelect.value, ui.graphGirderSelect);
  renderProfileChart();
  renderPlanChart();
});

ui.graphGirderSelect.addEventListener("change", () => {
  renderProfileChart();
  renderPlanChart();
});

ui.planChart.addEventListener("plotly_click", (event) => {
  if (event?.event?.button !== 0) return;
  const payload = event?.points?.[0]?.customdata;
  if (!payload) return;
  const [span, girder] = payload;
  if (ui.graphSpanSelect.value !== span) {
    ui.graphSpanSelect.value = span;
    populateGirderSelect(span, ui.graphGirderSelect);
  }
  ui.graphGirderSelect.value = girder;
  renderProfileChart();
  renderPlanChart();
});

if (ui.deckSpanSelect) {
  ui.deckSpanSelect.addEventListener("change", () => {
    populateGirderSelect(ui.deckSpanSelect.value, ui.deckGirderSelect);
    renderDeflectedDeckChart();
  });
}

if (ui.deckGirderSelect) {
  ui.deckGirderSelect.addEventListener("change", renderDeflectedDeckChart);
}

if (ui.deckChart) {
  ui.deckChart.addEventListener("plotly_click", (event) => {
    if (event?.event?.button !== 0) return;
    const payload = event?.points?.[0]?.customdata;
    if (!payload || payload.length !== 2) return;
    const [span, girder] = payload;
    if (ui.deckSpanSelect.value !== span) {
      ui.deckSpanSelect.value = span;
      populateGirderSelect(span, ui.deckGirderSelect);
    }
    ui.deckGirderSelect.value = girder;
    renderDeflectedDeckChart();
  });
}

const computeDeckBtn = document.getElementById("computeDeckBtn");
if (computeDeckBtn) {
  computeDeckBtn.addEventListener("click", () => {
    computeDeflectedDeck();
  });
}

setProgress(0, "Waiting for input");
