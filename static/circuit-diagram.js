(function () {
    var WIDTH = 640;
    var HEIGHT = 420;
    var MAX_NEIGHBORS = 24;

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function readData(container) {
        var data = { edges: [], path: [], candidates: [], fixed: [], focus: "" };
        try {
            data.edges = JSON.parse(container.dataset.edges || "[]");
            data.path = JSON.parse(container.dataset.path || "[]");
            data.candidates = JSON.parse(container.dataset.candidates || "[]");
            data.fixed = JSON.parse(container.dataset.fixed || "[]");
            data.focus = JSON.parse(container.dataset.focus || '""');
        } catch (e) {
            /* leave defaults on malformed data */
        }
        return data;
    }

    function buildAdjacency(edges) {
        var adjacency = {};
        edges.forEach(function (edge) {
            var a = edge[0];
            var b = edge[1];
            if (!adjacency[a]) adjacency[a] = [];
            if (!adjacency[b]) adjacency[b] = [];
            if (adjacency[a].indexOf(b) === -1) adjacency[a].push(b);
            if (adjacency[b].indexOf(a) === -1) adjacency[b].push(a);
        });
        return adjacency;
    }

    function currentFocus(data) {
        if (data.path.length > 0) return data.path[data.path.length - 1];
        var startSelect = document.getElementById("start_point");
        return (startSelect && startSelect.value) || "";
    }

    function selectedCandidate() {
        var nextSelect = document.getElementById("next_point");
        return (nextSelect && nextSelect.value) || null;
    }

    function nodeMarkup(id, pos, isFocus, options) {
        var classes = ["diagram-node"];
        if (isFocus) classes.push("diagram-node-focus");
        if (options.isPrevPathPoint) classes.push("diagram-node-path");
        if (options.isCandidate) classes.push("diagram-node-candidate");
        if (options.isSelected) classes.push("diagram-node-selected");

        var safeId = escapeHtml(id);
        var r = isFocus ? 12 : 8;
        var shape;
        if (options.isFixed) {
            var side = r * 2;
            shape =
                '<rect x="' + (pos.x - r) + '" y="' + (pos.y - r) + '" width="' + side + '" height="' + side +
                '" class="' + classes.join(" ") + '" data-point="' + safeId + '"></rect>';
        } else {
            shape =
                '<circle cx="' + pos.x + '" cy="' + pos.y + '" r="' + r + '" class="' + classes.join(" ") +
                '" data-point="' + safeId + '"></circle>';
        }
        var label = '<text x="' + pos.x + '" y="' + (pos.y - r - 8) + '" class="diagram-label">' + safeId + "</text>";
        return shape + label;
    }

    function renderEgoView(container, adjacency, data) {
        var focus = currentFocus(data);

        if (!focus) {
            container.innerHTML = '<p class="help-text diagram-placeholder">Select a start point above to preview its connections.</p>';
            return;
        }

        var allNeighbors = (adjacency[focus] || []).slice().sort();
        if (allNeighbors.length === 0) {
            container.innerHTML =
                '<p class="help-text diagram-placeholder">' + escapeHtml(focus) + " has no other leg connections.</p>";
            return;
        }

        var overflow = allNeighbors.length - MAX_NEIGHBORS;
        var neighbors = allNeighbors.slice(0, MAX_NEIGHBORS);

        var centerX = WIDTH / 2;
        var centerY = HEIGHT / 2;
        var radius = Math.min(WIDTH, HEIGHT) / 2 - 70;
        var positions = {};
        positions[focus] = { x: centerX, y: centerY };
        var count = neighbors.length;
        neighbors.forEach(function (id, idx) {
            var angle = (idx / count) * Math.PI * 2 - Math.PI / 2;
            positions[id] = { x: centerX + radius * Math.cos(angle), y: centerY + radius * Math.sin(angle) };
        });

        var fixedSet = {};
        data.fixed.forEach(function (id) {
            fixedSet[id] = true;
        });
        var candidateSet = {};
        data.candidates.forEach(function (id) {
            candidateSet[id] = true;
        });
        var prevPoint = data.path.length > 1 ? data.path[data.path.length - 2] : null;
        var selected = selectedCandidate();

        var parts = [];
        parts.push('<svg viewBox="0 0 ' + WIDTH + " " + HEIGHT + '" class="circuit-diagram-svg">');

        neighbors.forEach(function (id) {
            var b = positions[id];
            var edgeClass = id === prevPoint ? "diagram-path-edge" : "diagram-edge";
            parts.push(
                '<line x1="' + centerX + '" y1="' + centerY + '" x2="' + b.x + '" y2="' + b.y +
                    '" class="' + edgeClass + '"></line>'
            );
        });

        parts.push(
            nodeMarkup(focus, positions[focus], true, {
                isFixed: !!fixedSet[focus],
                isPrevPathPoint: false,
                isCandidate: false,
                isSelected: false,
            })
        );
        neighbors.forEach(function (id) {
            parts.push(
                nodeMarkup(id, positions[id], false, {
                    isFixed: !!fixedSet[id],
                    isPrevPathPoint: id === prevPoint,
                    isCandidate: !!candidateSet[id],
                    isSelected: id === selected,
                })
            );
        });

        parts.push("</svg>");
        if (overflow > 0) {
            parts.push(
                '<p class="help-text diagram-overflow-note">+' + overflow + " more connected point" +
                    (overflow === 1 ? "" : "s") + " not shown.</p>"
            );
        }

        container.innerHTML = parts.join("");

        container.querySelectorAll(".diagram-node-candidate").forEach(function (el) {
            el.addEventListener("click", function () {
                var select = document.getElementById("next_point");
                if (select) {
                    select.value = el.getAttribute("data-point");
                    select.dispatchEvent(new Event("change"));
                }
            });
        });
    }

    function initDiagram(container) {
        function draw() {
            var data = readData(container);
            renderEgoView(container, buildAdjacency(data.edges), data);
        }

        var startSelect = document.getElementById("start_point");
        if (startSelect) startSelect.addEventListener("change", draw);
        var nextSelect = document.getElementById("next_point");
        if (nextSelect) nextSelect.addEventListener("change", draw);

        draw();
    }

    function initAllDiagrams() {
        document.querySelectorAll("#circuit-diagram-root").forEach(function (container) {
            initDiagram(container);
        });
    }

    document.addEventListener("DOMContentLoaded", initAllDiagrams);
    document.addEventListener("panels:updated", initAllDiagrams);
})();
