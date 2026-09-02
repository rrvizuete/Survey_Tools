(function () {
    var WIDTH = 700;
    var HEIGHT = 560;
    var RING_SPACING = 88;
    var MAX_DEPTH = 3;
    var MAX_FORWARD_NODES = 30;
    var BACKWARD_ANGLE = 180;
    var FORWARD_ANGLE_START = -155;
    var FORWARD_ANGLE_END = 155;

    function toRadians(deg) {
        return (deg * Math.PI) / 180;
    }

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

    function buildBackwardChain(path, maxDepth) {
        var chain = [];
        for (var i = 1; i <= maxDepth; i++) {
            var idx = path.length - 1 - i;
            if (idx < 0) break;
            chain.push(path[idx]);
        }
        return chain;
    }

    function buildForwardNodes(focus, adjacency, excludeSet, maxDepth, maxNodes) {
        var nodes = [{ id: focus, depth: 0, parentId: null }];
        var visited = {};
        visited[focus] = true;
        Object.keys(excludeSet).forEach(function (id) {
            visited[id] = true;
        });

        var frontier = [focus];
        var count = 1;
        var truncated = false;

        for (var depth = 1; depth <= maxDepth && count < maxNodes; depth++) {
            var nextFrontier = [];
            for (var i = 0; i < frontier.length; i++) {
                var parent = frontier[i];
                var neighbors = (adjacency[parent] || []).slice().sort();
                for (var j = 0; j < neighbors.length; j++) {
                    var nb = neighbors[j];
                    if (visited[nb]) continue;
                    if (count >= maxNodes) {
                        truncated = true;
                        break;
                    }
                    visited[nb] = true;
                    nodes.push({ id: nb, depth: depth, parentId: parent });
                    nextFrontier.push(nb);
                    count++;
                }
            }
            frontier = nextFrontier;
        }

        return { nodes: nodes, truncated: truncated };
    }

    function assignAngles(nodes, angleStart, angleEnd) {
        var childrenOf = {};
        nodes.forEach(function (n) {
            if (n.parentId === null) return;
            if (!childrenOf[n.parentId]) childrenOf[n.parentId] = [];
            childrenOf[n.parentId].push(n);
        });

        var angleRanges = {};
        var root = nodes[0];
        angleRanges[root.id] = [angleStart, angleEnd];
        root.angle = (angleStart + angleEnd) / 2;

        nodes.forEach(function (n) {
            var kids = childrenOf[n.id];
            if (!kids || kids.length === 0) return;
            var range = angleRanges[n.id] || [angleStart, angleEnd];
            var span = (range[1] - range[0]) / kids.length;
            kids.forEach(function (kid, i) {
                var kStart = range[0] + i * span;
                var kEnd = range[0] + (i + 1) * span;
                angleRanges[kid.id] = [kStart, kEnd];
                kid.angle = (kStart + kEnd) / 2;
            });
        });
    }

    function nodeMarkup(id, pos, options) {
        var classes = ["diagram-node"];
        if (options.isFocus) classes.push("diagram-node-focus");
        if (options.isPath) classes.push("diagram-node-path");
        if (options.isCandidate) classes.push("diagram-node-candidate");
        if (options.isSelected) classes.push("diagram-node-selected");
        if (options.isMinor) classes.push("diagram-node-minor");

        var safeId = escapeHtml(id);
        var r = options.isFocus ? 12 : options.isMinor ? 6 : 8;
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
        var labelClass = options.isMinor ? "diagram-label diagram-label-minor" : "diagram-label";
        var label = '<text x="' + pos.x + '" y="' + (pos.y - r - 7) + '" class="' + labelClass + '">' + safeId + "</text>";
        return shape + label;
    }

    function renderEgoView(container, adjacency, data) {
        var focus = currentFocus(data);

        if (!focus) {
            container.innerHTML = '<p class="help-text diagram-placeholder">Select a start point above to preview its connections.</p>';
            return;
        }

        var centerX = WIDTH / 2;
        var centerY = HEIGHT / 2;
        var positions = {};
        positions[focus] = { x: centerX, y: centerY };

        var backward = buildBackwardChain(data.path, MAX_DEPTH);
        backward.forEach(function (id, i) {
            var depth = i + 1;
            var radius = depth * RING_SPACING;
            positions[id] = {
                x: centerX + radius * Math.cos(toRadians(BACKWARD_ANGLE)),
                y: centerY + radius * Math.sin(toRadians(BACKWARD_ANGLE)),
            };
        });

        var excludeSet = {};
        data.path.forEach(function (id) {
            excludeSet[id] = true;
        });
        var forward = buildForwardNodes(focus, adjacency, excludeSet, MAX_DEPTH, MAX_FORWARD_NODES);
        assignAngles(forward.nodes, FORWARD_ANGLE_START, FORWARD_ANGLE_END);
        forward.nodes.forEach(function (node) {
            if (node.depth === 0) return;
            var radius = node.depth * RING_SPACING;
            positions[node.id] = {
                x: centerX + radius * Math.cos(toRadians(node.angle)),
                y: centerY + radius * Math.sin(toRadians(node.angle)),
            };
        });

        if (backward.length === 0 && forward.nodes.length === 1) {
            container.innerHTML =
                '<p class="help-text diagram-placeholder">' + escapeHtml(focus) + " has no other leg connections.</p>";
            return;
        }

        var fixedSet = {};
        data.fixed.forEach(function (id) {
            fixedSet[id] = true;
        });
        var candidateSet = {};
        data.candidates.forEach(function (id) {
            candidateSet[id] = true;
        });
        var selected = selectedCandidate();

        var parts = [];
        parts.push('<svg viewBox="0 0 ' + WIDTH + " " + HEIGHT + '" class="circuit-diagram-svg">');

        var prev = focus;
        backward.forEach(function (id) {
            var a = positions[prev];
            var b = positions[id];
            parts.push('<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" class="diagram-path-edge"></line>');
            prev = id;
        });

        forward.nodes.forEach(function (node) {
            if (node.parentId === null) return;
            var a = positions[node.parentId];
            var b = positions[node.id];
            if (!a || !b) return;
            var edgeClass = node.depth === 1 ? "diagram-edge" : "diagram-edge-minor";
            parts.push('<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" class="' + edgeClass + '"></line>');
        });

        parts.push(
            nodeMarkup(focus, positions[focus], {
                isFocus: true,
                isFixed: !!fixedSet[focus],
            })
        );

        backward.forEach(function (id) {
            parts.push(
                nodeMarkup(id, positions[id], {
                    isPath: true,
                    isFixed: !!fixedSet[id],
                })
            );
        });

        forward.nodes.forEach(function (node) {
            if (node.depth === 0) return;
            parts.push(
                nodeMarkup(node.id, positions[node.id], {
                    isFixed: !!fixedSet[node.id],
                    isCandidate: node.depth === 1 && !!candidateSet[node.id],
                    isSelected: node.id === selected,
                    isMinor: node.depth > 1,
                })
            );
        });

        parts.push("</svg>");
        if (forward.truncated) {
            parts.push('<p class="help-text diagram-overflow-note">Some further connections are not shown.</p>');
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
