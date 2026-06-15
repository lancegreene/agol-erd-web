// insights.js — pure, view-time derivations over a graph dict. No DOM, no
// viewer globals. Inlined into the self-contained viewer by renderer.py (CLI)
// and app.js (web) via the INSIGHTS_JS token; loaded directly by the
// web repo's test/tests.html for unit tests. Keep this the single source.
"use strict";

const Insights = (() => {
  const STALE_MONTHS = 18;
  const SERVICE_TYPES = ["Feature Service", "Map Image Service"];

  function computeEmptyLayers(graph) {
    const out = [];
    for (const n of graph.nodes) {
      if (n.external) continue;
      for (const l of (n.layers || [])) {
        if (l.recordCount === 0) {
          out.push({serviceId: n.id, service: String(n.title),
                    layer: String(l.name), index: l.index, isTable: !!l.isTable});
        }
      }
    }
    return out;
  }

  function computeUnusedServices(graph) {
    const consumed = new Set(graph.edges.map(e => e.to));
    return graph.nodes
      .filter(n => !n.external && SERVICE_TYPES.includes(n.type) && !consumed.has(n.id))
      .map(n => ({id: n.id, title: String(n.title)}))
      .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  }

  function computeStaleItems(graph, nowMs, staleMonths) {
    const months = staleMonths == null ? STALE_MONTHS : staleMonths;
    const cutoff = new Date(nowMs == null ? Date.now() : nowMs);
    cutoff.setMonth(cutoff.getMonth() - months);
    const out = [];
    for (const n of graph.nodes) {
      if (n.external || !n.modified) continue;
      const d = new Date(n.modified + "T00:00:00");
      if (!isNaN(d) && d < cutoff) {
        out.push({id: n.id, title: String(n.title), modified: n.modified});
      }
    }
    out.sort((a, b) => (a.modified < b.modified ? -1 : a.modified > b.modified ? 1 : 0));
    return out;
  }

  function computeOwners(graph) {
    const counts = new Map();
    for (const n of graph.nodes) {
      if (n.external) continue;
      const o = n.owner || "(unknown)";
      counts.set(o, (counts.get(o) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([owner, count]) => ({owner, count}))
      .sort((a, b) => (b.count - a.count) || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  }

  return {STALE_MONTHS, computeEmptyLayers, computeUnusedServices,
          computeStaleItems, computeOwners};
})();
