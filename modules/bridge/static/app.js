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
// on-screen column since it is already covered in the user manual.
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
  dtmTin: null,
  isopachMesh: null,
  deflectedDeck: null,
  alignments: [],
  alignment: null,
  sectionStations: [],
  sectionStation: null,
  sectionRangeNote: "",
  section: null,
  // Bumped whenever the plotted data set changes, so the deck plan keeps the
  // user's zoom while only the section line moves.
  planRevision: 0,
};

const ui = {
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
  alignmentFileInput: document.getElementById("alignmentFileInput"),
  alignmentUploadStatus: document.getElementById("alignmentUploadStatus"),
  alignmentSelect: document.getElementById("alignmentSelect"),
  sectionIntervalInput: document.getElementById("sectionIntervalInput"),
  sectionStationSelect: document.getElementById("sectionStationSelect"),
  sectionStationInput: document.getElementById("sectionStationInput"),
  sectionStatus: document.getElementById("sectionStatus"),
  sectionChart: document.getElementById("sectionChart"),
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
    refreshSections();
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
  const planEdges = [];

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
    // The same left/right edge positions the Top of Girder export uses, so
    // the deflected deck can be reported directly above them.
    planEdges.push({ n: leftN, e: leftE, side: "L" }, { n: rightN, e: rightE, side: "R" });
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
    planEdges,
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
    state.dtmTin = null;
    state.dtmBoundary = null;
    state.planRevision += 1;
    ui.dtmUploadStatus.textContent = "";
    refreshSections();
    renderDeflectedDeckChart();
    return;
  }

  const text = await readTextFile(file);
  const { surfaces } = BridgeLandXml.parseLandXml(text);
  const surface = surfaces[0];
  state.dtm = surface;
  // Reused verbatim in the exported surface so it keeps the source's units.
  state.dtmUnitsXml = (text.match(/<Units>[\s\S]*?<\/Units>/) || [null])[0];
  state.dtmFileName = file.name;
  state.dtmTin = BridgeIsopach.buildTinInterpolator(surface.points, surface.faces);
  state.dtmBoundary = null;
  state.planRevision += 1;

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

  refreshSections();
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

// How much of the deck, inward from the DTM edge, sets the cross slope that
// is carried out to the overhang (screed) line.
const CROSS_SLOPE_RUN = 2;
// Tolerance (ft) when deciding whether a point is within the overhang.
const OVERHANG_TOLERANCE = 1e-3;

/**
 * Deck side edges -- the DTM boundary running along the given exterior
 * girders -- with outward normals. The overhang is measured perpendicular to
 * these edges, which may curve (they usually follow the alignment) even where
 * the girders are straight.
 */
function deckSidesFor(fascias) {
  if (!state.dtmBoundary) {
    state.dtmBoundary = BridgeSurfaceExport.tinBoundary(state.dtm.points, state.dtm.faces);
  }
  return BridgeSurfaceExport.deckSideEdges(state.dtmBoundary, fascias);
}

/**
 * Deck elevation at a deck-edge point and the cross slope carried out from it
 * (over the last CROSS_SLOPE_RUN ft of the model, perpendicular to the edge).
 * `z(d)` gives the deck elevation `d` ft beyond the edge.
 */
function deckEdgeProfile(tin, edgePoint) {
  const nudge = 1e-4; // read just inside the edge, where the TIN is certain to answer
  // At a deck corner, straight inward runs along the end edge, where the TIN
  // has no answer; step a hair along the edge (either way) to stay on the deck.
  const tangent = { e: -edgePoint.normal.n, n: edgePoint.normal.e };
  const inward = (s) => {
    for (const t of [0, 0.01, -0.01]) {
      const z = tin.sample(
        edgePoint.e - edgePoint.normal.e * s + tangent.e * t,
        edgePoint.n - edgePoint.normal.n * s + tangent.n * t,
      );
      if (z !== null) return z;
    }
    return null;
  };
  const edgeZ = inward(nudge);
  if (edgeZ === null) return null;
  const backZ = inward(CROSS_SLOPE_RUN);
  const slope = backZ === null ? 0 : (edgeZ - backZ) / (CROSS_SLOPE_RUN - nudge);
  return { slope, z: (d) => edgeZ + slope * (d + nudge) };
}

/**
 * Deck elevations out to the overhang (screed) line. Inside the DTM this is
 * the TIN elevation. Between the deck edge and the screed line -- the
 * overhang offset beyond the edge, perpendicular to it -- the last
 * CROSS_SLOPE_RUN ft of deck is carried out at its own cross slope, so a
 * surveyor gets prorated elevations where the screed sits beyond the model.
 */
function buildDeckSurface(tin, mesh, overhangOffset) {
  const sides = overhangOffset !== null && mesh && tin ? deckSidesFor(mesh.overhangEdges) : null;
  const active = Boolean(sides?.edges.length);

  /** Deck-edge point and distance beyond it, if the point is in the overhang. */
  function locate(e, n) {
    const edge = BridgeSurfaceExport.closestOnDeckEdge(sides, e, n);
    if (!edge) return null;
    const dE = e - edge.e;
    const dN = n - edge.n;
    const along = dE * edge.normal.e + dN * edge.normal.n;
    const lateral = Math.abs(dE * edge.normal.n - dN * edge.normal.e);
    if (along <= 0 || along > overhangOffset + OVERHANG_TOLERANCE) return null;
    // Past the end of a deck side (e.g. beyond the abutment corner) the
    // closest edge point is the corner, off to one side: not overhang.
    if (lateral > OVERHANG_TOLERANCE + 0.05 * along) return null;
    return { edge, along };
  }

  /** The overhang carries the deflection it has at the deck edge (the fascia girder's). */
  const edgeMeshPoint = (edge) => ({ e: edge.e - edge.normal.e * 1e-4, n: edge.n - edge.normal.n * 1e-4 });

  return {
    extends: active,
    sides,
    /** True where the deck exists only because of the overhang extension. */
    inOverhangBand(e, n) {
      return active && (!tin || tin.sample(e, n) === null) && locate(e, n) !== null;
    },
    /** Deflection to apply at a plan position, including across the overhang. */
    isopachAt(e, n) {
      const hit = mesh?.sample(e, n);
      if (hit) return hit.value;
      if (!active) return 0;
      const band = locate(e, n);
      if (!band) return 0;
      const point = edgeMeshPoint(band.edge);
      return mesh.sample(point.e, point.n)?.value ?? 0;
    },
    /** {z, extended, crossSlope, meshPoint?} or null where there is no deck. */
    sample(e, n) {
      const z = tin ? tin.sample(e, n) : null;
      if (z !== null) return { z, extended: false, crossSlope: null };
      if (!active) return null;
      const hit = locate(e, n);
      if (!hit) return null;
      const profile = deckEdgeProfile(tin, hit.edge);
      if (!profile) return null;
      return {
        z: profile.z(hit.along),
        extended: true,
        crossSlope: profile.slope,
        meshPoint: edgeMeshPoint(hit.edge),
      };
    },
  };
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

  // The overhang offset is measured perpendicular to the edge of deck (where
  // the DTM ends), which may curve while the girders are straight. For each
  // exterior girder interval, take the nearest point on its deck edge and go
  // out the offset along that edge's outward normal.
  const edgeRanges = [];
  const screedGeometry = new Map();
  const overhangPoints =
    overhangOffset === null
      ? undefined
      : ({ span, girder, points, normals }) => {
          const sides = deckSidesFor([{ fascia: points, outward: normals }]);
          if (!sides.edges.length) {
            logLine(
              `Overhang WARNING: Span ${span}, Girder ${girder}: no deck edge was found alongside this exterior ` +
                "girder, so the overhang offset is measured from the girder centerline instead.",
            );
            return points.map((point, index) => ({
              e: point.e + normals[index].e * overhangOffset,
              n: point.n + normals[index].n * overhangOffset,
            }));
          }
          const edges = points.map((point) => BridgeSurfaceExport.closestOnDeckEdge(sides, point.e, point.n));
          screedGeometry.set(`${span}||${girder}`, edges);
          const toEdge = edges.map((edge) => edge.distance);
          edgeRanges.push({ span, girder, min: Math.min(...toEdge), max: Math.max(...toEdge) });
          return edges.map((edge) => ({
            e: edge.e + edge.normal.e * overhangOffset,
            n: edge.n + edge.normal.n * overhangOffset,
          }));
        };

  const mesh = BridgeIsopach.buildIsopachMesh({
    spanToGirders: state.spanToGirders,
    girderGeometry: state.girderGeometry,
    profiles: state.profiles,
    overhangOffset,
    overhangPoints,
  });
  mesh.warnings.forEach((warning) => logLine(`Isopach WARNING: ${warning}`));
  if (overhangOffset === null) {
    logLine("Isopach: no overhang offset given; the deck is not extended past the DTM.");
  } else {
    logLine(
      `Isopach: overhang edge set ${overhangOffset.toFixed(3)} ft beyond the edge of deck (DTM edge), ` +
        "measured perpendicular to the deck edge.",
    );
    edgeRanges.forEach((range) => {
      logLine(
        `Overhang: Span ${range.span}, Girder ${range.girder}: edge of deck ${range.min.toFixed(3)}` +
          (range.max - range.min > 0.001 ? ` to ${range.max.toFixed(3)}` : "") +
          " ft from the girder centerline.",
      );
    });
  }

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
  // deflected surface directly above the girder's left and right edges instead
  // -- the same plan positions and names as the Top of Girder export -- so each
  // girder has elevations to report regardless of where the DTM places vertices.
  const tin = state.dtmTin;
  const girderPoints = {};
  let sampledGirders = 0;

  sortedSpans().forEach((span) => {
    sortedGirders(span).forEach((girder) => {
      const key = `${span}||${girder}`;
      const edges = state.girderGeometry[key]?.planEdges;
      if (!edges?.length) return;

      const sampled = [];
      edges.forEach((point, index) => {
        const interval = Math.floor(index / 2);
        const deckZ = tin.sample(point.e, point.n);
        if (deckZ === null) return;
        const hit = mesh.sample(point.e, point.n);
        const isopach = hit ? hit.value : 0;
        sampled.push({
          e: point.e,
          n: point.n,
          interval,
          side: point.side,
          code: `${formatSpan(span)}${formatGirder(girder)}${formatInterval(interval)}${point.side}`,
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

  // Screed points: the overhang edge at every girder interval, with the deck
  // carried out at its cross slope and the fascia girder's deflection added.
  const deckSurface = buildDeckSurface(tin, mesh, overhangOffset);
  const edgePoints = [];
  let extendedEdgePoints = 0;
  if (deckSurface.extends) {
    mesh.overhangEdges.forEach((edge) => {
      const key = `${edge.span}||${edge.girder}`;
      const profile = state.profiles[key] ?? [];
      const deckEdges = screedGeometry.get(key);
      edge.points.forEach((point, interval) => {
        if (!profile[interval]) return;
        // Carry the deck out from the deck-edge point this screed point was
        // placed from; without one (no deck edge found) fall back to sampling.
        const deckEdge = deckEdges?.[interval];
        const edgeProfile = deckEdge ? deckEdgeProfile(tin, deckEdge) : null;
        const deck = edgeProfile
          ? { z: edgeProfile.z(overhangOffset), extended: true, crossSlope: edgeProfile.slope }
          : deckSurface.sample(point.e, point.n);
        if (!deck) return;
        // The overhang row carries the fascia value by construction; read it
        // from the profile rather than sampling right on the mesh boundary.
        const isopach = profile[interval].deflectionIn / 12;
        if (deck.extended) extendedEdgePoints += 1;
        edgePoints.push({
          span: edge.span,
          girder: edge.girder,
          interval,
          e: point.e,
          n: point.n,
          originalZ: deck.z,
          extended: deck.extended,
          crossSlope: deck.crossSlope,
          isopach,
          deflectedZ: deck.z + isopach,
        });
      });
    });
  }

  state.isopachMesh = mesh;
  state.deflectedDeck = { points, inside, girderPoints, overhangOffset, deckSurface, edgePoints };
  state.planRevision += 1;

  if (deckSurface.extends) {
    const expected = mesh.overhangEdges.reduce((total, edge) => total + edge.points.length, 0);
    logLine(
      `Overhang: ${edgePoints.length} of ${expected} screed points sampled, ${extendedEdgePoints} of them past the ` +
        `DTM edge (deck carried out at its cross slope over the last ${CROSS_SLOPE_RUN} ft of the model).`,
    );
    if (edgePoints.length < expected) {
      logLine(
        "Overhang WARNING: some screed points have no deck elevation; the DTM does not reach the exterior girder there.",
      );
    }
  }

  logLine(
    `Deflected deck: ${points.length} DTM points - ${inside} inside the isopach surface, ` +
      `${points.length - inside} outside (isopach held at 0, original elevation kept).`,
  );
  if (tin.triangleCount) {
    logLine(
      `Deflected deck: sampled deck elevations above the left and right edges of ${sampledGirders} girders ` +
        "(same positions and names as the Top of Girder points).",
    );
  } else {
    logLine(
      "Deflected deck NOTE: the DTM has no TIN faces, so deck elevations could not be sampled along the " +
        "girder centerlines. Only the surface's own points are shown.",
    );
  }
  logDeckReferenceStats();

  refreshSections();
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
  const surface = state.deflectedDeck?.deckSurface;
  const extendsDeck = Boolean(surface?.extends);

  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  const include = (point) => {
    if (point.e < minE) minE = point.e;
    if (point.e > maxE) maxE = point.e;
    if (point.n < minN) minN = point.n;
    if (point.n > maxN) maxN = point.n;
  };
  rings.forEach((ring) => ring.forEach(include));
  // With an overhang offset the deck reaches the screed line, past the DTM.
  if (extendsDeck) mesh.overhangEdges.forEach((edge) => edge.points.forEach(include));

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
      if (!BridgeIsopach.pointInRings(e, n, rings) && !(extendsDeck && surface.inOverhangBand(e, n))) return null;
      if (extendsDeck) return surface.isopachAt(e, n);
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

  // Overhang (screed) lines only exist when the user gave an offset; the
  // blank-offset mesh edge is an internal detail, not a deck edge.
  const screedEdges = state.deflectedDeck?.deckSurface?.extends ? state.isopachMesh.overhangEdges : [];
  const screedPoints = state.deflectedDeck?.edgePoints ?? [];
  screedEdges.forEach((edge) => {
    const points = screedPoints.filter((point) => point.span === edge.span && point.girder === edge.girder);
    traces.push({
      x: points.map((point) => point.e),
      y: points.map((point) => point.n),
      mode: "lines+markers",
      line: { width: 2, color: "#fd7e14", dash: "dash" },
      marker: { size: 6, color: "#fd7e14" },
      name: `Span ${edge.span} - overhang edge at Girder ${edge.girder}`,
      customdata: points.map((point) => [
        `${formatSpan(point.span)}${formatGirder(point.girder)}${formatInterval(point.interval)}OH`,
        point.originalZ,
        point.isopach,
        point.deflectedZ,
        point.extended ? "carried at cross slope" : "from DTM",
      ]),
      hovertemplate:
        "<b>%{customdata[0]}</b> (overhang edge)<br>N %{y:.3f}<br>E %{x:.3f}<br>" +
        "Deck %{customdata[1]:.3f} ft (%{customdata[4]})<br>Deflection %{customdata[2]:.3f} ft<br>" +
        "<b>Deflected %{customdata[3]:.3f} ft</b><extra></extra>",
    });
  });

  alignmentPlanTraces().forEach((trace) => traces.push(trace));

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
        // Label with the point code used in the export (…L / …R, as in the Top
        // of Girder export), so a point on the plan can be matched to its row.
        // Left labels go above and right labels below so the pairs stay legible.
        text: selectedPoints.map((point) => point.code),
        textposition: selectedPoints.map((point) => (point.side === "L" ? "top center" : "bottom center")),
        textfont: { size: 10, color: "#212529" },
        name: `Span ${selectedSpan} - Girder ${selectedGirder}`,
        customdata: selectedPoints.map((point) => [...toCustomdata(point), point.code]),
        hovertemplate: "<b>%{customdata[3]}</b><br>" + hover,
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
        `${deck.points.length - deck.inside} keeping their original elevation).` +
        (deck.edgePoints?.length
          ? ` ${deck.edgePoints.length} overhang edge points ${deck.overhangOffset} ft beyond the edge of deck.`
          : "");
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

  Plotly.react(
    ui.deckChart,
    traces,
    {
      uirevision: state.planRevision,
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

// ---------------------------------------------------------------------------
// Alignment sections
// ---------------------------------------------------------------------------

const MAX_SECTION_STATIONS = 2000;
const SECTION_SAMPLES = 600;

/** Every plan point that belongs to the bridge: girder centerlines and deck outline. */
function bridgePlanPoints() {
  const points = [];
  Object.values(state.girderGeometry).forEach((geometry) => {
    (geometry?.planCenterline ?? []).forEach((point) => points.push(point));
  });
  getDeckOutlineRings().forEach((ring) => ring.forEach((point) => points.push(point)));
  return points;
}

/** Station range of the bridge along an alignment, or the whole alignment if unknown. */
function bridgeStationRange(alignment) {
  let min = Infinity;
  let max = -Infinity;
  let known = 0;
  let alongside = 0;
  bridgePlanPoints().forEach((point) => {
    known += 1;
    const hit = alignment.stationOffsetOf(point.e, point.n);
    // Points past the alignment's ends all pile up on the end station.
    if (!hit || hit.beyondEnds) return;
    alongside += 1;
    if (hit.station < min) min = hit.station;
    if (hit.station > max) max = hit.station;
  });
  // An alignment that only grazes the bridge (e.g. ends at it) gives a
  // sliver of a range; treat it as not running alongside.
  if (!(max - min > 1) || alongside < known * 0.25) {
    return { min: alignment.staStart, max: alignment.staEnd, fromBridge: false, offBridge: known > 0 };
  }
  return { min, max, fromBridge: true };
}

/** Mean distance from the bridge to an alignment, used to pick a sensible default. */
function bridgeDistanceTo(alignment) {
  const points = bridgePlanPoints();
  if (!points.length) return 0;
  const step = Math.max(1, Math.floor(points.length / 200));
  let total = 0;
  let count = 0;
  for (let i = 0; i < points.length; i += step) {
    const hit = alignment.stationOffsetOf(points[i].e, points[i].n);
    if (!hit) continue;
    total += hit.distance;
    count += 1;
  }
  return count ? total / count : Infinity;
}

function readSectionInterval() {
  const value = Number(ui.sectionIntervalInput?.value);
  return Number.isFinite(value) && value > 0 ? value : 10;
}

function populateSectionStationSelect() {
  const select = ui.sectionStationSelect;
  if (!state.sectionStations.length) {
    select.innerHTML = '<option value="">(Upload an alignment)</option>';
    select.disabled = true;
    return;
  }

  select.disabled = false;
  select.innerHTML = "";
  state.sectionStations.forEach((station) => {
    const option = document.createElement("option");
    option.value = station.toFixed(4);
    option.textContent = BridgeAlignment.formatStation(station);
    select.appendChild(option);
  });
  if (state.sectionStation !== null && state.sectionStation !== undefined) {
    select.value = state.sectionStation.toFixed(4);
  }
}

function rebuildSectionStations() {
  const alignment = state.alignment;
  if (!alignment) {
    state.sectionStations = [];
    return "";
  }

  const range = bridgeStationRange(alignment);
  let interval = readSectionInterval();
  let note = "";
  if ((range.max - range.min) / interval > MAX_SECTION_STATIONS) {
    interval = Math.ceil((range.max - range.min) / MAX_SECTION_STATIONS);
    note = ` Interval raised to ${interval} ft to keep the station list under ${MAX_SECTION_STATIONS} entries.`;
  }

  // Round stations land on the interval; the bridge's own first and last
  // stations are always included so both ends can be inspected.
  const stations = [range.min];
  for (let station = Math.ceil(range.min / interval) * interval; station < range.max; station += interval) {
    if (station - stations[stations.length - 1] > 1e-6) stations.push(station);
  }
  if (range.max - stations[stations.length - 1] > 1e-6) stations.push(range.max);

  // Keep a station the user typed in, if it still falls on the alignment.
  const current = state.sectionStation;
  if (
    current !== null &&
    current !== undefined &&
    current >= alignment.staStart &&
    current <= alignment.staEnd &&
    !stations.some((station) => Math.abs(station - current) < 1e-6)
  ) {
    stations.push(current);
    stations.sort((a, b) => a - b);
  }

  state.sectionStations = stations;
  if (!stations.some((station) => Math.abs(station - (current ?? NaN)) < 1e-6)) {
    // Default to the station nearest mid-bridge.
    const middle = (range.min + range.max) / 2;
    state.sectionStation = stations.reduce((best, station) =>
      Math.abs(station - middle) < Math.abs(best - middle) ? station : best,
    );
  }

  if (range.fromBridge) {
    return `Bridge spans stations ${BridgeAlignment.formatStation(range.min)} to ${BridgeAlignment.formatStation(range.max)}.${note}`;
  }
  return range.offBridge
    ? `The bridge is not alongside this alignment, so the whole alignment is listed; choose another alignment.${note}`
    : `Run the calculation or load the DTM to limit stations to the bridge.${note}`;
}

/** Rebuilds the station list and redraws the section; call after any input changes. */
function refreshSections() {
  if (!ui.sectionChart) return;
  state.sectionRangeNote = rebuildSectionStations();
  populateSectionStationSelect();
  renderSectionChart();
}

function nearestListedStation(station) {
  if (!state.sectionStations.length) return station;
  return state.sectionStations.reduce((best, candidate) =>
    Math.abs(candidate - station) < Math.abs(best - station) ? candidate : best,
  );
}

function showSectionAt(station) {
  if (!state.alignment || !Number.isFinite(station)) return;
  state.sectionStation = station;
  if (!state.sectionStations.some((listed) => Math.abs(listed - station) < 1e-6)) {
    state.sectionStations.push(station);
    state.sectionStations.sort((a, b) => a - b);
  }
  populateSectionStationSelect();
  renderSectionChart();
  renderDeflectedDeckChart();
}

function stepSection(direction) {
  const stations = state.sectionStations;
  if (!stations.length) return;
  const index = stations.findIndex((station) => Math.abs(station - state.sectionStation) < 1e-6);
  const next = Math.max(0, Math.min(stations.length - 1, (index < 0 ? 0 : index) + direction));
  showSectionAt(stations[next]);
}

/** Section-line crossings of a plan polyline, deduplicated at shared vertices. */
function sectionCrossings(origin, right, polyline) {
  const offsets = [];
  BridgeAlignment.crossingsOf(origin, right, polyline).forEach((hit) => {
    if (!offsets.some((offset) => Math.abs(offset - hit.offset) < 1e-6)) offsets.push(hit.offset);
  });
  return offsets;
}

function buildSection(station) {
  const alignment = state.alignment;
  const frame = alignment.pointAt(station);
  const origin = { e: frame.e, n: frame.n };
  const right = { e: frame.rightE, n: frame.rightN };
  const at = (offset) => ({ e: origin.e + right.e * offset, n: origin.n + right.n * offset });

  const mesh = state.deflectedDeck ? state.isopachMesh : null;
  const tin = state.dtmTin;
  const surface = state.deflectedDeck?.deckSurface ?? null;
  const extendsDeck = Boolean(surface?.extends);

  const girders = [];
  sortedSpans().forEach((span) => {
    sortedGirders(span).forEach((girder) => {
      const centerline = state.girderGeometry[`${span}||${girder}`]?.planCenterline;
      if (!centerline?.length) return;
      sectionCrossings(origin, right, centerline).forEach((offset) => girders.push({ span, girder, offset }));
    });
  });

  const overhangs = [];
  (extendsDeck ? mesh.overhangEdges : []).forEach((edge) => {
    sectionCrossings(origin, right, edge.points).forEach((offset) =>
      overhangs.push({ span: edge.span, girder: edge.girder, offset }),
    );
  });

  const deckEdges = [];
  getDeckOutlineRings().forEach((ring) => {
    if (ring.length >= 3) sectionCrossings(origin, right, ring.concat([ring[0]])).forEach((o) => deckEdges.push(o));
  });

  const featureOffsets = girders
    .map((item) => item.offset)
    .concat(overhangs.map((item) => item.offset), deckEdges);
  if (!featureOffsets.length) return { station, origin, right, empty: true };

  let minOffset = Math.min(...featureOffsets);
  let maxOffset = Math.max(...featureOffsets);
  const pad = Math.max(2, (maxOffset - minOffset) * 0.04);
  minOffset -= pad;
  maxOffset += pad;

  const sampleSurfaces = (offset) => {
    const point = at(offset);
    let deck = null;
    if (surface) deck = surface.sample(point.e, point.n);
    else if (tin) {
      const z = tin.sample(point.e, point.n);
      deck = z === null ? null : { z, extended: false };
    }
    if (!deck) return { offset, originalZ: null, isopach: null, deflectedZ: null, extended: false };

    const meshPoint = deck.meshPoint ?? point;
    const hit = mesh ? mesh.sample(meshPoint.e, meshPoint.n) : null;
    const isopach = mesh ? (hit ? hit.value : 0) : null;
    return {
      offset,
      originalZ: deck.z,
      isopach,
      deflectedZ: mesh ? deck.z + isopach : null,
      extended: deck.extended,
    };
  };

  // Regular samples plus the exact feature offsets, so girder and edge
  // elevations are read at the marker rather than interpolated between samples.
  const offsets = [];
  for (let i = 0; i <= SECTION_SAMPLES; i += 1) {
    offsets.push(minOffset + ((maxOffset - minOffset) * i) / SECTION_SAMPLES);
  }
  featureOffsets.forEach((offset) => offsets.push(offset));
  offsets.sort((a, b) => a - b);

  const profile = offsets.map(sampleSurfaces);
  girders.forEach((item) => Object.assign(item, sampleSurfaces(item.offset), at(item.offset)));
  overhangs.forEach((item) => Object.assign(item, sampleSurfaces(item.offset), at(item.offset)));

  return { station, origin, right, minOffset, maxOffset, profile, girders, overhangs, hasDeflected: Boolean(mesh) };
}

function renderSectionChart() {
  if (!ui.sectionChart) return;

  const setStatus = (text) => {
    ui.sectionStatus.textContent = text;
  };

  state.section = null;
  if (!state.alignment) {
    Plotly.purge(ui.sectionChart);
    setStatus("Upload a civil alignment (LandXML) to draw sections across the deck.");
    return;
  }
  if (!state.dtmTin?.triangleCount) {
    Plotly.purge(ui.sectionChart);
    setStatus(
      state.dtm
        ? "The DTM has no TIN faces, so sections cannot be sampled from it."
        : "Upload the top-of-deck DTM to draw sections.",
    );
    return;
  }

  const station = state.sectionStation;
  if (!Number.isFinite(station)) {
    Plotly.purge(ui.sectionChart);
    setStatus("Choose a station.");
    return;
  }

  const section = buildSection(station);
  const stationText = BridgeAlignment.formatStation(station);
  if (section.empty) {
    Plotly.purge(ui.sectionChart);
    setStatus(`Station ${stationText} does not cross the deck or any girder.`);
    return;
  }
  state.section = section;

  const x = section.profile.map((point) => point.offset);
  const profile = section.profile;
  // Split each surface into the part read from the DTM (solid) and the part
  // carried out at the cross slope to the screed line (dashed). The dashed
  // part repeats its neighbouring DTM sample so the two lines join.
  const touchesExtended = (i) => profile[i - 1]?.extended || profile[i + 1]?.extended;
  const modelPart = (value) => profile.map((point) => (point.extended ? null : value(point)));
  const extendedPart = (value) =>
    profile.map((point, i) => (point.extended || (value(point) !== null && touchesExtended(i)) ? value(point) : null));
  const hasExtended = profile.some((point) => point.extended);
  const deflectionIn = profile.map((point) => (point.isopach === null ? null : point.isopach * 12));

  const traces = [
    {
      x,
      y: modelPart((point) => point.originalZ),
      mode: "lines",
      line: { width: 2.5, color: "#1b5ba3" },
      name: "Original DTM",
      legendgroup: "original",
      hovertemplate: "%{y:.3f} ft<extra>Original</extra>",
    },
  ];
  if (hasExtended) {
    traces.push({
      x,
      y: extendedPart((point) => point.originalZ),
      mode: "lines",
      line: { width: 2.5, color: "#1b5ba3", dash: "dash" },
      name: "Original, carried at cross slope",
      legendgroup: "original",
      hovertemplate: "%{y:.3f} ft<extra>Original (extended)</extra>",
    });
  }

  if (section.hasDeflected) {
    traces.push({
      x,
      y: modelPart((point) => point.deflectedZ),
      customdata: deflectionIn,
      mode: "lines",
      line: { width: 2.5, color: "#dc3545" },
      name: "Deflected",
      legendgroup: "deflected",
      hovertemplate: "%{y:.3f} ft (deflection %{customdata:.3f} in)<extra>Deflected</extra>",
    });
    if (hasExtended) {
      traces.push({
        x,
        y: extendedPart((point) => point.deflectedZ),
        customdata: deflectionIn,
        mode: "lines",
        line: { width: 2.5, color: "#dc3545", dash: "dash" },
        name: "Deflected, carried at cross slope",
        legendgroup: "deflected",
        hovertemplate: "%{y:.3f} ft (deflection %{customdata:.3f} in)<extra>Deflected (extended)</extra>",
      });
    }
  }

  const spansCrossed = new Set(section.girders.map((item) => item.span));
  const girderLabel = (item) => (spansCrossed.size > 1 ? `${item.span}-G${item.girder}` : `G${item.girder}`);
  const markerZ = (item) => (section.hasDeflected ? item.deflectedZ : item.originalZ);

  const girdersWithZ = section.girders.filter((item) => markerZ(item) !== null);
  if (girdersWithZ.length) {
    traces.push({
      x: girdersWithZ.map((item) => item.offset),
      y: girdersWithZ.map(markerZ),
      mode: "markers",
      marker: { size: 9, color: "#212529", symbol: "triangle-down", line: { width: 1, color: "#fff" } },
      name: "Girders",
      customdata: girdersWithZ.map((item) => [
        item.span,
        item.girder,
        item.originalZ,
        item.isopach === null ? 0 : item.isopach * 12,
        item.n,
        item.e,
      ]),
      hovertemplate:
        "<b>Span %{customdata[0]} - Girder %{customdata[1]}</b><br>Offset %{x:.3f} ft<br>" +
        "N %{customdata[4]:.3f}  E %{customdata[5]:.3f}<br>DTM %{customdata[2]:.3f} ft<br>" +
        (section.hasDeflected ? "Deflection %{customdata[3]:.3f} in<br><b>Deflected %{y:.3f} ft</b>" : "") +
        "<extra></extra>",
    });
  }

  const overhangsWithZ = section.overhangs.filter((item) => markerZ(item) !== null);
  if (overhangsWithZ.length) {
    traces.push({
      x: overhangsWithZ.map((item) => item.offset),
      y: overhangsWithZ.map(markerZ),
      mode: "markers",
      marker: { size: 9, color: "#fd7e14", symbol: "diamond", line: { width: 1, color: "#fff" } },
      name: "Overhang edges",
      customdata: overhangsWithZ.map((item) => [
        item.span,
        item.girder,
        item.originalZ,
        item.isopach === null ? 0 : item.isopach * 12,
        item.extended ? "carried at cross slope" : "from DTM",
      ]),
      hovertemplate:
        "<b>Overhang edge (Span %{customdata[0]}, Girder %{customdata[1]})</b><br>Offset %{x:.3f} ft<br>" +
        "Deck %{customdata[2]:.3f} ft (%{customdata[4]})<br>Deflection %{customdata[3]:.3f} in<br>" +
        "<b>Deflected %{y:.3f} ft</b><extra></extra>",
    });
  }

  const shapes = [];
  const annotations = [];
  const verticalLine = (offset, color, dash) =>
    shapes.push({
      type: "line",
      xref: "x",
      yref: "paper",
      x0: offset,
      x1: offset,
      y0: 0,
      y1: 1,
      line: { color, width: 1, dash },
    });
  const topLabel = (offset, text, color) =>
    annotations.push({
      x: offset,
      y: 1,
      xref: "x",
      yref: "paper",
      yanchor: "bottom",
      text,
      showarrow: false,
      font: { size: 10, color },
    });

  section.girders.forEach((item) => {
    verticalLine(item.offset, "#6c757d", "dot");
    topLabel(item.offset, girderLabel(item), "#343a40");
  });
  section.overhangs.forEach((item) => {
    verticalLine(item.offset, "#fd7e14", "dash");
    topLabel(item.offset, "OH", "#c35a00");
  });
  if (section.minOffset <= 0 && section.maxOffset >= 0) {
    verticalLine(0, "#198754", "dashdot");
    topLabel(0, "CL", "#198754");
  }

  Plotly.newPlot(
    ui.sectionChart,
    traces,
    {
      title: { text: `<b>Section at Sta ${stationText}</b> - ${state.alignment.name}`, y: 0.97 },
      xaxis: {
        title: { text: "Offset from alignment (ft) - left negative, right positive" },
        range: [section.minOffset, section.maxOffset],
        zeroline: false,
      },
      yaxis: { title: { text: "Elevation (ft)" }, tickformat: ".2f", automargin: true },
      hovermode: "closest",
      shapes,
      annotations,
      margin: { t: 90, r: 25, b: 110, l: 80 },
      paper_bgcolor: "#fcfdff",
      plot_bgcolor: "#fcfdff",
      showlegend: true,
      legend: { orientation: "h", x: 0, y: -0.2, yanchor: "top" },
    },
    PLOTLY_CONFIG,
  );

  const deflections = section.girders.map((item) => item.isopach).filter((value) => value !== null);
  const parts = [
    `Sta ${stationText}: ${section.girders.length} girder crossing(s), ${section.overhangs.length} overhang edge(s).`,
  ];
  if (section.hasDeflected && deflections.length) {
    const largest = deflections.reduce((best, value) => (Math.abs(value) > Math.abs(best) ? value : best));
    parts.push(`Largest girder deflection here: ${(largest * 12).toFixed(3)} in.`);
  } else if (!section.hasDeflected) {
    parts.push("Compute the deflected deck to add the deflected surface and overhang edges.");
  }
  if (state.sectionRangeNote) parts.push(state.sectionRangeNote);
  setStatus(parts.join(" "));
}

/** Alignment (clipped near the bridge) and the current section line, for the deck plan. */
function alignmentPlanTraces() {
  const alignment = state.alignment;
  if (!alignment) return [];

  const range = bridgeStationRange(alignment);
  const margin = range.fromBridge ? Math.max(20, (range.max - range.min) * 0.1) : 0;
  const from = Math.max(alignment.staStart, range.min - margin);
  const to = Math.min(alignment.staEnd, range.max + margin);

  // Sample the exact geometry across the clipped range rather than filtering
  // the densified vertices: a long straight <Line> has only its two end
  // vertices, which both fall outside the range when it runs past the bridge.
  // Regular samples also give every point a station to click on.
  const count = Math.max(2, Math.min(1000, Math.ceil((to - from) / 2) + 1));
  const shown = [];
  for (let i = 0; i < count && to > from; i += 1) {
    const station = from + ((to - from) * i) / (count - 1);
    const frame = alignment.pointAt(station);
    shown.push({ e: frame.e, n: frame.n, station });
  }
  const traces = [];
  if (shown.length >= 2) {
    traces.push({
      x: shown.map((point) => point.e),
      y: shown.map((point) => point.n),
      mode: "lines",
      line: { width: 2, color: "#198754", dash: "dashdot" },
      name: alignment.name,
      customdata: shown.map((point) => [point.station]),
      hovertemplate: `${alignment.name}<br>Sta %{customdata[0]:.2f}<br>Click to cut a section<extra></extra>`,
    });
  }

  const section = state.section;
  if (section && !section.empty) {
    const ends = [section.minOffset, section.maxOffset].map((offset) => ({
      e: section.origin.e + section.right.e * offset,
      n: section.origin.n + section.right.n * offset,
    }));
    traces.push({
      x: ends.map((point) => point.e),
      y: ends.map((point) => point.n),
      mode: "lines+text",
      line: { width: 3, color: "#0dcaf0" },
      text: ["", `Sta ${BridgeAlignment.formatStation(section.station)}`],
      textposition: "middle right",
      textfont: { size: 11, color: "#055160" },
      name: "Section line",
      hoverinfo: "skip",
    });
  }
  return traces;
}

async function loadAlignmentFile() {
  const [file] = ui.alignmentFileInput.files;
  state.alignments = [];
  state.alignment = null;
  state.sectionStation = null;

  if (!file) {
    ui.alignmentUploadStatus.textContent = "";
    populateAlignmentSelect();
    refreshSections();
    renderDeflectedDeckChart();
    return;
  }

  const { alignments, errors } = BridgeAlignment.parseAlignments(await readTextFile(file));
  state.alignments = alignments;
  errors.forEach((message) => logLine(`Alignment WARNING: ${message}`));

  // Default to the alignment that runs closest to the bridge.
  let bestIndex = 0;
  if (alignments.length > 1) {
    let bestDistance = Infinity;
    alignments.forEach((alignment, index) => {
      const distance = bridgeDistanceTo(alignment);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
  }

  populateAlignmentSelect(bestIndex);
  selectAlignment(bestIndex);
  ui.alignmentUploadStatus.textContent = `Loaded ${alignments.length} alignment(s) from "${file.name}".`;
}

function populateAlignmentSelect(selectedIndex = 0) {
  const select = ui.alignmentSelect;
  if (!state.alignments.length) {
    select.innerHTML = '<option value="">(Upload an alignment)</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = "";
  state.alignments.forEach((alignment, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent =
      `${alignment.name} (Sta ${BridgeAlignment.formatStation(alignment.staStart)} to ` +
      `${BridgeAlignment.formatStation(alignment.staEnd)})`;
    select.appendChild(option);
  });
  select.value = String(selectedIndex);
}

function selectAlignment(index) {
  const alignment = state.alignments[index];
  if (!alignment) return;
  state.alignment = alignment;
  state.sectionStation = null;

  logLine(
    `Alignment: "${alignment.name}" - ${alignment.elementCount} element(s), stations ` +
      `${BridgeAlignment.formatStation(alignment.staStart)} to ${BridgeAlignment.formatStation(alignment.staEnd)}.`,
  );
  alignment.warnings.forEach((warning) => logLine(`Alignment WARNING (${alignment.name}): ${warning}`));

  refreshSections();
  renderDeflectedDeckChart();
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
  state.planRevision += 1;

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
        planEdges: result.planEdges,
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
    const edgePoints = state.deflectedDeck.edgePoints ?? [];
    const rows = [
      ["N", "E", "Deflected Elevation (ft)", "Description", "Deck Elevation (ft)", "Isopach (ft)", "Note"],
    ];

    let screedRows = 0;
    sortedSpans().forEach((span) => {
      sortedGirders(span).forEach((girder) => {
        (girderPoints[`${span}||${girder}`] ?? []).forEach((point) => {
          rows.push([
            point.n,
            point.e,
            point.deflectedZ,
            point.code,
            point.originalZ,
            point.isopach,
            "",
          ]);
        });
      });

      // Screed points along the overhang edges, after the span's girders.
      edgePoints
        .filter((point) => point.span === span)
        .forEach((point) => {
          screedRows += 1;
          rows.push([
            point.n,
            point.e,
            point.deflectedZ,
            `${formatSpan(span)}${formatGirder(point.girder)}${formatInterval(point.interval)}OH`,
            point.originalZ,
            point.isopach,
            point.extended
              ? `Overhang edge; deck carried at ${(point.crossSlope * 100).toFixed(2)}% cross slope past the DTM`
              : "Overhang edge; deck from DTM",
          ]);
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
    logLine(
      `Export: wrote ${rows.length - 1 - screedRows} deflected deck points at girder intervals` +
        (screedRows ? ` and ${screedRows} overhang (screed) points` : "") +
        ' to "ToD Deflected.xlsx".',
    );
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

// Plan grid (ft) used to densify the deck TIN so the deflection curve is
// captured between the DTM's own vertices.
const SURFACE_CELL_SIZE = 5;

function exportDeflectedSurfaceXml() {
  if (!state.topOfGirderPoints.length) {
    window.alert("Please calculate the top-of-girder points first (Girder Calcs tab).");
    return;
  }
  if (!state.dtm) {
    window.alert("Please upload the top-of-deck DTM XML surface first.");
    return;
  }
  if (!state.deflectedDeck && !computeDeflectedDeck()) return;
  if (!state.dtm.faces.length) {
    window.alert("The DTM has no TIN faces, so a deflected surface cannot be built from it.");
    return;
  }

  const mesh = state.isopachMesh;
  const tin = state.dtmTin;
  const overhangOffset = state.deflectedDeck.overhangOffset;
  const surface = BridgeSurfaceExport.buildDeflectedSurface({
    points: state.dtm.points,
    faces: state.dtm.faces,
    isopachAt: (e, n) => mesh.sample(e, n)?.value ?? 0,
    deckZ: (e, n) => tin.sample(e, n),
    cellSize: SURFACE_CELL_SIZE,
    overhangOffset,
    // The exterior girders, so the deck's side edges can be found locally.
    fascias: mesh.overhangEdges,
    crossSlopeRun: CROSS_SLOPE_RUN,
  });

  const name = `${state.dtm.name} - Deflected`;
  const description =
    overhangOffset === null
      ? "Top of deck plus girder deflection (isopach)"
      : `Top of deck plus girder deflection, extended ${overhangOffset} ft beyond the edge of deck at its cross slope`;
  const xml = BridgeSurfaceExport.toLandXml(surface, { name, description, unitsXml: state.dtmUnitsXml });

  const url = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
  triggerDownload(url, "ToD Deflected Surface.xml");
  logLine(
    `Export: wrote surface "${name}" to "ToD Deflected Surface.xml" - ${surface.vertices.length} points, ` +
      `${surface.faces.length} faces (deck densified on a ${SURFACE_CELL_SIZE} ft grid` +
      (surface.stripFaces ? `, plus ${surface.stripFaces} faces out to the overhang edge).` : ")."),
  );
  if (overhangOffset !== null && !surface.stripFaces) {
    logLine("Export WARNING: no deck side edges were found to extend, so the surface stops at the DTM edge.");
  }
  return { surface, xml };
}

function downloadLog() {
  const blob = new Blob([ui.logOutput.textContent || "No log entries yet."], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, "Log.txt");
}

renderSourceGrid();

ui.tabDataBtn.addEventListener("click", () => activateTab("data"));
ui.tabGraphsBtn.addEventListener("click", () => activateTab("graphs"));
ui.tabExportBtn.addEventListener("click", () => activateTab("export"));

document.getElementById("downloadTemplateBtn").addEventListener("click", downloadTemplate);
document.getElementById("calculateBtn").addEventListener("click", runCalculation);
document.getElementById("exportGirderBtn").addEventListener("click", exportTopOfGirderPoints);
document.getElementById("projectBtn").addEventListener("click", exportTopOfDeckDeflected);
document.getElementById("exportSurfaceBtn").addEventListener("click", exportDeflectedSurfaceXml);
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
    state.dtmTin = null;
    state.dtmBoundary = null;
    state.deflectedDeck = null;
    ui.dtmUploadStatus.textContent = `Error loading DTM: ${error.message}`;
    logLine(`DTM ERROR: ${error.message}`);
    refreshSections();
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

if (ui.alignmentFileInput) {
  ui.alignmentFileInput.addEventListener("change", async () => {
    try {
      await loadAlignmentFile();
    } catch (error) {
      state.alignments = [];
      state.alignment = null;
      populateAlignmentSelect();
      ui.alignmentUploadStatus.textContent = `Error loading alignment: ${error.message}`;
      logLine(`Alignment ERROR: ${error.message}`);
      refreshSections();
      renderDeflectedDeckChart();
    }
  });

  ui.alignmentSelect.addEventListener("change", () => selectAlignment(Number(ui.alignmentSelect.value)));
  ui.sectionIntervalInput.addEventListener("change", () => {
    refreshSections();
    renderDeflectedDeckChart();
  });
  ui.sectionStationSelect.addEventListener("change", () => showSectionAt(Number(ui.sectionStationSelect.value)));
  document.getElementById("sectionPrevBtn").addEventListener("click", () => stepSection(-1));
  document.getElementById("sectionNextBtn").addEventListener("click", () => stepSection(1));

  const goToStation = () => {
    if (!state.alignment) {
      window.alert("Please upload a civil alignment first.");
      return;
    }
    const station = BridgeAlignment.parseStation(ui.sectionStationInput.value);
    if (station === null) {
      window.alert("Enter a station such as 12+34.50 or 1234.50.");
      return;
    }
    if (station < state.alignment.staStart - 1e-6 || station > state.alignment.staEnd + 1e-6) {
      window.alert(
        `Station ${BridgeAlignment.formatStation(station)} is outside the alignment ` +
          `(${BridgeAlignment.formatStation(state.alignment.staStart)} to ` +
          `${BridgeAlignment.formatStation(state.alignment.staEnd)}).`,
      );
      return;
    }
    showSectionAt(station);
  };
  document.getElementById("sectionGoBtn").addEventListener("click", goToStation);
  ui.sectionStationInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") goToStation();
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
    // The alignment trace carries [station]; girders carry [span, girder].
    if (Array.isArray(payload) && payload.length === 1 && Number.isFinite(payload[0])) {
      showSectionAt(nearestListedStation(payload[0]));
      return;
    }
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
refreshSections();
