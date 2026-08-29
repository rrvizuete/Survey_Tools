(function () {
    var WIDTH = 800;
    var HEIGHT = 480;
    var MAX_NODES = 300;

    function fnv1aHash(str) {
        var h = 0x811c9dc5;
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
    }

    function seededRandom(seed) {
        var state = seed % 2147483647;
        if (state <= 0) state += 2147483646;
        return function () {
            state = (state * 16807) % 2147483647;
            return (state - 1) / 2147483646;
        };
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function computeLayout(nodeIds, edges) {
        var nodes = {};
        nodeIds.forEach(function (id) {
            var rand = seededRandom(fnv1aHash(id) || 1);
            nodes[id] = { x: 40 + rand() * (WIDTH - 80), y: 40 + rand() * (HEIGHT - 80) };
        });

        if (nodeIds.length < 2) return nodes;

        var area = WIDTH * HEIGHT;
        var k = Math.sqrt(area / nodeIds.length);
        var iterations = 150;

        for (var iter = 0; iter < iterations; iter++) {
            var temperature = k * (1 - iter / iterations) * 0.6;
            var forces = {};
            nodeIds.forEach(function (id) {
                forces[id] = { fx: 0, fy: 0 };
            });

            for (var i = 0; i < nodeIds.length; i++) {
                for (var j = i + 1; j < nodeIds.length; j++) {
                    var a = nodes[nodeIds[i]];
                    var b = nodes[nodeIds[j]];
                    var dx = a.x - b.x;
                    var dy = a.y - b.y;
                    var dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
                    var force = (k * k) / dist;
                    var fx = (dx / dist) * force;
                    var fy = (dy / dist) * force;
                    forces[nodeIds[i]].fx += fx;
                    forces[nodeIds[i]].fy += fy;
                    forces[nodeIds[j]].fx -= fx;
                    forces[nodeIds[j]].fy -= fy;
                }
            }

            edges.forEach(function (edge) {
                var a = nodes[edge[0]];
                var b = nodes[edge[1]];
                if (!a || !b) return;
                var dx = a.x - b.x;
                var dy = a.y - b.y;
                var dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
                var force = (dist * dist) / k;
                var fx = (dx / dist) * force;
                var fy = (dy / dist) * force;
                forces[edge[0]].fx -= fx;
                forces[edge[0]].fy -= fy;
                forces[edge[1]].fx += fx;
                forces[edge[1]].fy += fy;
            });

            nodeIds.forEach(function (id) {
                var n = nodes[id];
                var f = forces[id];
                var centerFx = (WIDTH / 2 - n.x) * 0.01;
                var centerFy = (HEIGHT / 2 - n.y) * 0.01;
                f.fx += centerFx;
                f.fy += centerFy;

                var disp = Math.sqrt(f.fx * f.fx + f.fy * f.fy) || 0.01;
                var limited = Math.min(disp, temperature || 1);
                n.x += (f.fx / disp) * limited;
                n.y += (f.fy / disp) * limited;
                n.x = Math.max(24, Math.min(WIDTH - 24, n.x));
                n.y = Math.max(24, Math.min(HEIGHT - 24, n.y));
            });
        }

        return nodes;
    }

    function renderDiagram(container) {
        var edges = [];
        var path = [];
        var candidates = [];
        var fixedList = [];

        try {
            edges = JSON.parse(container.dataset.edges || "[]");
            path = JSON.parse(container.dataset.path || "[]");
            candidates = JSON.parse(container.dataset.candidates || "[]");
            fixedList = JSON.parse(container.dataset.fixed || "[]");
        } catch (e) {
            container.innerHTML = "";
            return;
        }

        var nodeSet = {};
        edges.forEach(function (edge) {
            nodeSet[edge[0]] = true;
            nodeSet[edge[1]] = true;
        });
        path.forEach(function (id) {
            nodeSet[id] = true;
        });
        var nodeIds = Object.keys(nodeSet).sort();

        if (nodeIds.length === 0) {
            container.innerHTML = "";
            return;
        }

        if (nodeIds.length > MAX_NODES) {
            container.innerHTML =
                '<p class="help-text">Graph too large to visualize (' + nodeIds.length + " points).</p>";
            return;
        }

        var positions = computeLayout(nodeIds, edges);
        var fixedSet = {};
        fixedList.forEach(function (id) {
            fixedSet[id] = true;
        });
        var candidateSet = {};
        candidates.forEach(function (id) {
            candidateSet[id] = true;
        });
        var pathIndex = {};
        path.forEach(function (id, idx) {
            pathIndex[id] = idx;
        });

        var parts = [];
        parts.push('<svg viewBox="0 0 ' + WIDTH + " " + HEIGHT + '" class="circuit-diagram-svg">');

        edges.forEach(function (edge) {
            var a = positions[edge[0]];
            var b = positions[edge[1]];
            if (!a || !b) return;
            parts.push(
                '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" class="diagram-edge"></line>'
            );
        });

        for (var i = 0; i < path.length - 1; i++) {
            var a = positions[path[i]];
            var b = positions[path[i + 1]];
            if (!a || !b) continue;
            parts.push(
                '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" class="diagram-path-edge"></line>'
            );
        }

        nodeIds.forEach(function (id) {
            var pos = positions[id];
            if (!pos) return;
            var classes = ["diagram-node"];
            if (pathIndex.hasOwnProperty(id)) classes.push("diagram-node-path");
            if (candidateSet[id]) classes.push("diagram-node-candidate");

            var safeId = escapeHtml(id);
            if (fixedSet[id]) {
                parts.push(
                    '<rect x="' + (pos.x - 7) + '" y="' + (pos.y - 7) +
                        '" width="14" height="14" class="' + classes.join(" ") +
                        ' diagram-node-fixed" data-point="' + safeId + '"></rect>'
                );
            } else {
                parts.push(
                    '<circle cx="' + pos.x + '" cy="' + pos.y + '" r="7" class="' +
                        classes.join(" ") + '" data-point="' + safeId + '"></circle>'
                );
            }
            parts.push('<text x="' + pos.x + '" y="' + (pos.y - 12) + '" class="diagram-label">' + safeId + "</text>");
        });

        parts.push("</svg>");
        container.innerHTML = parts.join("");

        container.querySelectorAll(".diagram-node-candidate").forEach(function (el) {
            el.addEventListener("click", function () {
                var select = document.getElementById("next_point");
                if (select) {
                    select.value = el.getAttribute("data-point");
                }
            });
        });
    }

    function renderAllDiagrams() {
        document.querySelectorAll("#circuit-diagram-root").forEach(function (container) {
            renderDiagram(container);
        });
    }

    document.addEventListener("DOMContentLoaded", renderAllDiagrams);
    document.addEventListener("panels:updated", renderAllDiagrams);
})();
