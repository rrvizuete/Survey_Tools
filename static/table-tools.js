(function () {
    function cellText(cell) {
        return (cell.textContent || "").trim();
    }

    function parseNumeric(text) {
        if (text === "" || text === "—") return null;
        var cleaned = text.replace(/,/g, "");
        var n = parseFloat(cleaned);
        return Number.isNaN(n) ? null : n;
    }

    function applyFilters(table) {
        var thead = table.tHead;
        var tbody = table.tBodies[0];
        if (!thead || !tbody) return;

        var filterInputs = thead.querySelectorAll(".filter-row .filter-input");
        var filters = Array.prototype.map.call(filterInputs, function (input) {
            return input.value.trim().toLowerCase();
        });

        Array.prototype.forEach.call(tbody.rows, function (row) {
            var visible = true;
            for (var i = 0; i < filters.length; i++) {
                if (!filters[i]) continue;
                var cell = row.cells[i];
                if (!cell || cellText(cell).toLowerCase().indexOf(filters[i]) === -1) {
                    visible = false;
                    break;
                }
            }
            row.style.display = visible ? "" : "none";
        });
    }

    function sortByColumn(table, colIndex, th) {
        var tbody = table.tBodies[0];
        if (!tbody) return;
        var rows = Array.prototype.slice.call(tbody.rows);

        var currentDir = th.getAttribute("data-sort-dir");
        var nextDir = currentDir === "asc" ? "desc" : "asc";

        Array.prototype.forEach.call(table.tHead.rows[0].cells, function (headerCell) {
            if (headerCell !== th) headerCell.removeAttribute("data-sort-dir");
        });
        th.setAttribute("data-sort-dir", nextDir);

        var allNumeric = rows.every(function (row) {
            var cell = row.cells[colIndex];
            if (!cell) return true;
            var text = cellText(cell);
            return text === "" || text === "—" || parseNumeric(text) !== null;
        });

        rows.sort(function (a, b) {
            var cellA = a.cells[colIndex];
            var cellB = b.cells[colIndex];
            var textA = cellA ? cellText(cellA) : "";
            var textB = cellB ? cellText(cellB) : "";
            var result;

            if (allNumeric) {
                var numA = parseNumeric(textA);
                var numB = parseNumeric(textB);
                if (numA === null && numB === null) result = 0;
                else if (numA === null) result = -1;
                else if (numB === null) result = 1;
                else result = numA - numB;
            } else {
                result = textA.localeCompare(textB, undefined, { numeric: true, sensitivity: "base" });
            }

            return nextDir === "asc" ? result : -result;
        });

        rows.forEach(function (row) {
            tbody.appendChild(row);
        });
    }

    function enhanceTable(table) {
        if (table.dataset.toolsEnhanced) return;

        var thead = table.tHead;
        var tbody = table.tBodies[0];
        if (!thead || !tbody || !thead.rows.length) return;

        var headerRow = thead.rows[0];
        table.dataset.toolsEnhanced = "true";

        var filterRow = document.createElement("tr");
        filterRow.className = "filter-row";
        Array.prototype.forEach.call(headerRow.cells, function () {
            var td = document.createElement("td");
            var input = document.createElement("input");
            input.type = "text";
            input.placeholder = "Filter";
            input.className = "filter-input";
            input.addEventListener("input", function () {
                applyFilters(table);
            });
            td.appendChild(input);
            filterRow.appendChild(td);
        });
        thead.appendChild(filterRow);

        function syncStickyOffset() {
            var top = headerRow.offsetHeight + "px";
            Array.prototype.forEach.call(filterRow.cells, function (td) {
                td.style.top = top;
            });
        }
        syncStickyOffset();
        window.addEventListener("resize", syncStickyOffset);

        Array.prototype.forEach.call(headerRow.cells, function (th, colIndex) {
            th.classList.add("sortable-th");
            th.addEventListener("click", function () {
                sortByColumn(table, colIndex, th);
            });
        });
    }

    function enhanceAllTables(root) {
        (root || document).querySelectorAll(".table-wrap table").forEach(function (table) {
            enhanceTable(table);
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        enhanceAllTables(document);
    });

    window.enhanceAllTables = enhanceAllTables;
})();
