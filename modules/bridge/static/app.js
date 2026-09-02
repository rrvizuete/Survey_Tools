const HELP_TEXT = `1. Data & Calculation Tab:
   - Download Template to get the input Excel format.
   - Upload the completed "Girder Data sheet" file.
   - Review imported rows in the editable grid and adjust values before calculation.
   - Set "Centerline radius (ft)" per girder: 0 or blank means straight, positive is clockwise, negative is counterclockwise (from Support1 to Support2).
   - Set the number of intervals and run calculation.
   - The Calculation Log is displayed in this same tab and can be downloaded.

2. Graphs Tab:
   - Includes synchronized Deflection Profile and Plan View plots.
   - The plan uses Northing (N) and Easting (E) as coordinates.
   - Select Span/Girder from the selectors or click a girder in plan view.
   - Selected girder is highlighted, and the profile updates automatically.

3. DTM & Exports Tab:
   - Optionally upload a DTM XML surface file.
   - Export Top of Deck Deflected points after calculation.

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

const state = {
  sourceRows: [],
  topOfGirderPoints: [],
  profiles: {},
  spanToGirders: {},
  girderGeometry: {},
  logs: [],
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
  ui.sourceTableHead.innerHTML = `<tr>${TEMPLATE_HEADERS.map((h) => `<th>${h}</th>`).join("")}</tr>`;

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

function populateGraphSelectors() {
  const spans = Object.keys(state.spanToGirders).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (!spans.length) {
    ui.graphSpanSelect.innerHTML = '<option value="">(Run calculation first)</option>';
    ui.graphGirderSelect.innerHTML = '<option value="">(Run calculation first)</option>';
    ui.graphSpanSelect.disabled = true;
    ui.graphGirderSelect.disabled = true;
    return;
  }

  ui.graphSpanSelect.disabled = false;
  ui.graphSpanSelect.innerHTML = "";
  spans.forEach((span) => {
    const option = document.createElement("option");
    option.value = span;
    option.textContent = span;
    ui.graphSpanSelect.appendChild(option);
  });

  ui.graphSpanSelect.value = spans[0];
  populateGirderSelect(spans[0]);
}

function populateGirderSelect(spanValue) {
  const girders = Array.from(state.spanToGirders[spanValue] ?? []).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!girders.length) {
    ui.graphGirderSelect.innerHTML = '<option value="">(No girders found)</option>';
    ui.graphGirderSelect.disabled = true;
    return;
  }

  const previous = ui.graphGirderSelect.value;
  ui.graphGirderSelect.disabled = false;
  ui.graphGirderSelect.innerHTML = "";
  girders.forEach((girder) => {
    const option = document.createElement("option");
    option.value = girder;
    option.textContent = girder;
    ui.graphGirderSelect.appendChild(option);
  });
  ui.graphGirderSelect.value = girders.includes(previous) ? previous : girders[0];
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
    { responsive: true },
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
    { responsive: true },
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
  exportRowsAsWorkbook(output, "Top of girder.xlsx");
  setProgress(100, "Calculation complete");
}

function exportTopOfDeckDeflected() {
  if (!state.topOfGirderPoints.length) {
    window.alert("Please calculate the top-of-girder points first.");
    return;
  }

  const headers = ["N", "E", "Elevation (ft)", "Description"];
  const projectedRows = [headers];
  for (let i = 1; i < state.topOfGirderPoints.length; i += 1) {
    const [n, e, elevation, desc] = state.topOfGirderPoints[i];
    projectedRows.push([n, e, elevation, desc]);
  }

  exportRowsAsWorkbook(projectedRows, "ToD Deflected.xlsx");

  if (!ui.dtmFileInput.files.length) {
    state.logs.push(
      "Projection note: No DTM XML provided. Export used computed top-of-girder elevations only (no surface interpolation).",
    );
    ui.logOutput.textContent = state.logs.join("\n");
  }
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

ui.dtmFileInput.addEventListener("change", () => {
  ui.dtmUploadStatus.textContent = ui.dtmFileInput.files.length ? "DTM surface file uploaded correctly." : "";
});

ui.graphSpanSelect.addEventListener("change", () => {
  populateGirderSelect(ui.graphSpanSelect.value);
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
    populateGirderSelect(span);
  }
  ui.graphGirderSelect.value = girder;
  renderProfileChart();
  renderPlanChart();
});

setProgress(0, "Waiting for input");
