// report.js — port of erd_generator/report.py (markdown only; build_docx is
// CLI-only). Keep in sync with the Python; verified byte-equal by
// test/tests.html against test/vectors.json.
"use strict";

const Report = (() => {
  const APP_TYPES = ["Experience Builder", "Dashboard", "Web AppBuilder", "Instant App", "StoryMap"];
  const MAP_TYPES = ["Web Map", "Web Scene"];
  const SERVICE_TYPES = ["Feature Service", "Map Image Service"];
  const FORM_TYPE = "Survey123 Form";
  const MAX_TREE_DEPTH = 6;
  const LAYER_LIST_CAP = 25;
  const OTHER_DOMAIN = "other external items";
  const URL_HOST_RE = /:\/\/([^/]+)/;

  // Python-compatible string comparator (code-point order; NOT localeCompare).
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  function indexGraph(graph) {
    const byId = {};
    for (const node of graph.nodes) byId[node.id] = node;
    const children = new Map();   // sourceId -> Map(targetId -> {layers:Set, kinds:Set})
    const consumers = new Map();  // targetId -> Set(sourceId)
    const viewOf = {};
    for (const edge of graph.edges) {
      if (edge.kind === "view-of") {
        viewOf[edge.from] = edge.to;
      } else {
        if (!children.has(edge.from)) children.set(edge.from, new Map());
        const m = children.get(edge.from);
        if (!m.has(edge.to)) m.set(edge.to, {layers: new Set(), kinds: new Set()});
        const entry = m.get(edge.to);
        entry.kinds.add(edge.kind);
        if (edge.toLayer !== undefined && edge.toLayer !== null) entry.layers.add(edge.toLayer);
      }
      if (!consumers.has(edge.to)) consumers.set(edge.to, new Set());
      consumers.get(edge.to).add(edge.from);
    }
    return {byId, children, consumers, viewOf};
  }

  function displayTitles(nodes) {
    const counts = {};
    for (const node of nodes) {
      const t = String(node.title).trim();
      counts[t] = (counts[t] || 0) + 1;
    }
    const display = {};
    for (const node of nodes) {
      let title = String(node.title).trim();
      if (counts[title] > 1) {
        const sid = String(node.id);
        const tag = sid.length === 32 ? sid.slice(0, 8) : sid.slice(-8);
        title = title + " [" + tag + "]";
      }
      display[node.id] = title;
    }
    return display;
  }

  function externalDomain(node) {
    for (const value of [node.id, node.url, node.title]) {
      if (typeof value === "string") {
        const m = URL_HOST_RE.exec(value);
        if (m && m[1].trim()) return m[1].trim().toLowerCase();
      }
    }
    return OTHER_DOMAIN;
  }

  function metaLine(node) {
    const parts = [];
    if (node.owner) parts.push("Owner " + node.owner);
    if (node.modified) parts.push("Modified " + node.modified);
    if (node.sharing) parts.push("Sharing " + node.sharing);
    return parts.join(" · ");
  }

  function layerNote(layersSet) {
    if (!layersSet.size) return "";
    const nums = [...layersSet].sort((a, b) => a - b);
    const word = nums.length === 1 ? "layer" : "layers";
    return " — uses " + word + " " + nums.join(", ");
  }

  function cappedList(entries, fmt) {
    const shown = entries.slice(0, LAYER_LIST_CAP).map(fmt);
    const extra = entries.length - LAYER_LIST_CAP;
    if (extra > 0) shown.push("… and " + extra + " more");
    return shown.join(", ");
  }

  function fmtChangeLayer(layer) {
    const prefix = layer.isTable ? "table " : "";
    return prefix + layer.name + " (" + layer.index + ")";
  }

  function diffEdgeLine(edge, added) {
    let verb;
    if (edge.kind === "view-of") verb = added ? "is now a view of" : "is no longer a view of";
    else verb = added ? "now uses" : "no longer uses";
    const note = "toLayer" in edge ? " · layer " + edge.toLayer : "";
    return edge.fromTitle + " → " + verb + " " + edge.toTitle + note;
  }

  function diffBlocks(d) {
    const counts = [];
    if (d.addedItems.length) {
      const n = d.addedItems.length;
      counts.push("+" + n + " item" + (n !== 1 ? "s" : ""));
    }
    if (d.removedItems.length) {
      const n = d.removedItems.length;
      counts.push("−" + n + " item" + (n !== 1 ? "s" : ""));
    }
    const rel = d.addedEdges.length + d.removedEdges.length;
    if (rel) counts.push(rel + " relationship change" + (rel !== 1 ? "s" : ""));
    if (d.layerChanges.length) {
      const n = d.layerChanges.length;
      counts.push(n + " service schema change" + (n !== 1 ? "s" : ""));
    }
    let heading = "Changes since " + d.comparedTo;
    if (counts.length) heading += "  (" + counts.join(", ") + ")";
    const blocks = [["h2", heading]];
    if (!counts.length) {
      blocks.push(["text", "No changes since " + d.comparedTo + "."]);
      return blocks;
    }
    if (d.addedItems.length) {
      blocks.push(["h3", "Added items"]);
      for (const it of d.addedItems) blocks.push(["bullet", 0, it.title + " (" + it.type + ")"]);
    }
    if (d.removedItems.length) {
      blocks.push(["h3", "Removed items"]);
      for (const it of d.removedItems) blocks.push(["bullet", 0, it.title + " (" + it.type + ")"]);
    }
    if (d.addedEdges.length || d.removedEdges.length) {
      blocks.push(["h3", "Relationship changes"]);
      for (const e of d.addedEdges) blocks.push(["bullet", 0, diffEdgeLine(e, true)]);
      for (const e of d.removedEdges) blocks.push(["bullet", 0, diffEdgeLine(e, false)]);
    }
    if (d.layerChanges.length) {
      blocks.push(["h3", "Service layer changes"]);
      for (const ch of d.layerChanges) {
        const parts = [];
        if (ch.added.length) parts.push("added " + ch.added.map(fmtChangeLayer).join(", "));
        if (ch.removed.length) parts.push("removed " + ch.removed.map(fmtChangeLayer).join(", "));
        blocks.push(["bullet", 0, ch.title + ": " + parts.join(" · ")]);
      }
    }
    return blocks;
  }

  function tree(blocks, byId, children, display, nodeId, level, visited) {
    if (level > MAX_TREE_DEPTH) return;
    const entries = children.has(nodeId) ? [...children.get(nodeId).entries()] : [];
    entries.sort((a, b) => {
      const ta = byId[a[0]] ? byId[a[0]].type : "";
      const tb = byId[b[0]] ? byId[b[0]].type : "";
      const na = byId[a[0]] ? String(byId[a[0]].title).trim() : "";
      const nb = byId[b[0]] ? String(byId[b[0]].title).trim() : "";
      return cmp(ta, tb) || cmp(na, nb);
    });
    for (const [targetId, entry] of entries) {
      const target = byId[targetId];
      const title = targetId in display ? display[targetId] : String(targetId);
      const type = target ? target.type : "Unknown";
      if (visited.has(targetId)) {
        blocks.push(["bullet", level, type + ": " + title + " (shown above)"]);
        continue;
      }
      blocks.push(["bullet", level, type + ": " + title + layerNote(entry.layers)]);
      const nextVisited = new Set(visited);
      nextVisited.add(targetId);
      tree(blocks, byId, children, display, targetId, level + 1, nextVisited);
    }
  }

  function titles(display, ids) {
    return [...ids].map(i => (i in display ? display[i] : String(i))).sort(cmp);
  }

  function buildBlocks(graph) {
    const {byId, children, consumers, viewOf} = indexGraph(graph);
    const nodes = graph.nodes;
    const display = displayTitles(nodes);
    const meta = graph.meta;
    const blocks = [
      ["title", meta.group + " — Group Inventory"],
      ["meta", "Generated " + meta.generated + " · " + meta.org + " · " +
               nodes.length + " items, " + graph.edges.length + " links"],
    ];
    if (meta.diff) blocks.push(...diffBlocks(meta.diff));
    const covered = new Set();

    const apps = nodes.filter(n => APP_TYPES.includes(n.type) && !n.external);
    if (apps.length) {
      blocks.push(["h2", "Apps"]);
      const sortedApps = apps.slice().sort((a, b) =>
        (APP_TYPES.indexOf(a.type) - APP_TYPES.indexOf(b.type)) || cmp(display[a.id], display[b.id]));
      for (const app of sortedApps) {
        covered.add(app.id);
        blocks.push(["h3", display[app.id] + " (" + app.type + ")"]);
        if (metaLine(app)) blocks.push(["text", metaLine(app)]);
        if (children.has(app.id) && children.get(app.id).size) {
          tree(blocks, byId, children, display, app.id, 0, new Set([app.id]));
        } else {
          blocks.push(["text", "No relationships detected."]);
        }
      }
    }

    const appIds = new Set(apps.map(a => a.id));
    const orphanMaps = nodes.filter(n => MAP_TYPES.includes(n.type) && !n.external &&
      !([...(consumers.get(n.id) || new Set())].some(c => appIds.has(c))));
    if (orphanMaps.length) {
      blocks.push(["h2", "Web Maps not used by any app"]);
      for (const m of orphanMaps.slice().sort((a, b) => cmp(display[a.id], display[b.id]))) {
        covered.add(m.id);
        blocks.push(["h3", display[m.id]]);
        if (metaLine(m)) blocks.push(["text", metaLine(m)]);
        tree(blocks, byId, children, display, m.id, 0, new Set([m.id]));
      }
    }
    for (const n of nodes) {
      if (MAP_TYPES.includes(n.type) && !n.external) covered.add(n.id);
    }

    const forms = nodes.filter(n => n.type === FORM_TYPE);
    if (forms.length) {
      blocks.push(["h2", "Survey123 Forms"]);
      for (const form of forms.slice().sort((a, b) => cmp(display[a.id], display[b.id]))) {
        covered.add(form.id);
        const targets = titles(display, children.has(form.id) ? children.get(form.id).keys() : []);
        if (targets.length) {
          blocks.push(["bullet", 0, display[form.id] + " → submits to " + targets.join(", ")]);
        } else {
          blocks.push(["bullet", 0, display[form.id] + " (no service relationship found)"]);
        }
      }
    }

    const services = nodes.filter(n => SERVICE_TYPES.includes(n.type) && !n.external);
    if (services.length) {
      blocks.push(["h2", "Feature & Map Services"]);
      for (const svc of services.slice().sort((a, b) => cmp(display[a.id], display[b.id]))) {
        covered.add(svc.id);
        let suffix = svc.type;
        if (svc.id in viewOf && viewOf[svc.id] in byId) {
          suffix += " — view of " + display[viewOf[svc.id]];
        }
        blocks.push(["h3", display[svc.id] + " (" + suffix + ")"]);
        if (metaLine(svc)) blocks.push(["text", metaLine(svc)]);
        const all = svc.layers || [];
        const layers = all.filter(l => !l.isTable);
        const tables = all.filter(l => l.isTable);
        const parts = [];
        if (layers.length) parts.push("Layers: " + cappedList(layers, l => l.name + " (" + l.index + ")"));
        if (tables.length) parts.push("Tables: " + cappedList(tables, t => t.name + " (" + t.index + ")"));
        if (parts.length) blocks.push(["text", parts.join(" · ")]);
        const usedBy = titles(display, consumers.get(svc.id) || new Set());
        if (usedBy.length) blocks.push(["text", "Used by: " + usedBy.join(", ")]);
      }
    }

    const externals = nodes.filter(n => n.external);
    if (externals.length) {
      blocks.push(["h2", "External services referenced"]);
      const groups = new Map();
      for (const ext of externals) {
        const d = externalDomain(ext);
        if (!groups.has(d)) groups.set(d, []);
        groups.get(d).push(ext);
      }
      const sortedGroups = [...groups.entries()].sort((a, b) =>
        (b[1].length - a[1].length) || cmp(a[0], b[0]));
      for (const [domain, members] of sortedGroups) {
        let noun;
        if (domain === OTHER_DOMAIN) noun = members.length === 1 ? "item" : "items";
        else noun = members.length === 1 ? "service" : "services";
        blocks.push(["bullet", 0, domain + " — " + members.length + " " + noun]);
        for (const member of members.slice().sort((a, b) => cmp(display[a.id], display[b.id]))) {
          covered.add(member.id);
          const usedBy = titles(display, consumers.get(member.id) || new Set());
          let line = display[member.id];
          if (usedBy.length) line += " — used by: " + usedBy.join(", ");
          blocks.push(["bullet", 1, line]);
        }
      }
    }

    const leftovers = nodes.filter(n => !covered.has(n.id));
    const connected = leftovers.filter(n =>
      (children.has(n.id) && children.get(n.id).size) ||
      (consumers.has(n.id) && consumers.get(n.id).size));
    const unconnected = leftovers.filter(n => !connected.includes(n));
    if (connected.length) {
      blocks.push(["h2", "Other referenced items"]);
      for (const node of connected.slice().sort((a, b) => cmp(display[a.id], display[b.id]))) {
        const usedBy = titles(display, consumers.get(node.id) || new Set());
        let line = display[node.id] + " (" + node.type + ")";
        if (usedBy.length) line += " — used by: " + usedBy.join(", ");
        blocks.push(["bullet", 0, line]);
      }
    }
    if (unconnected.length) {
      blocks.push(["h2", "Other items (no detected relationships)"]);
      for (const node of unconnected.slice().sort((a, b) => cmp(display[a.id], display[b.id]))) {
        blocks.push(["bullet", 0, display[node.id] + " (" + node.type + ")"]);
      }
    }

    if (meta.warnings && meta.warnings.length) {
      blocks.push(["h2", "Harvest warnings"]);
      for (const w of meta.warnings) blocks.push(["bullet", 0, w]);
    }
    return blocks;
  }

  function renderMarkdown(blocks) {
    const lines = [];
    for (const block of blocks) {
      const kind = block[0];
      if (kind === "title") lines.push("# " + block[1], "");
      else if (kind === "h2") lines.push("", "## " + block[1], "");
      else if (kind === "h3") lines.push("", "### " + block[1], "");
      else if (kind === "meta" || kind === "text") lines.push(block[1], "");
      else if (kind === "bullet") lines.push("  ".repeat(block[1]) + "- " + block[2]);
    }
    return lines.join("\n").replace(/\s+$/, "") + "\n";
  }

  function buildMarkdown(graph) { return renderMarkdown(buildBlocks(graph)); }

  return {buildMarkdown, externalDomain};
})();
