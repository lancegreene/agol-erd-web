// harvest.js — browser port of erd_generator/harvester.py over raw AGOL REST.
// Same behavioral contract: sequential, per-item progress, 3-retry, per-item
// failures become parseWarnings, never a dead harvest.
// Documented divergence (spec): layer listing only for *.arcgis.com hosts.
"use strict";

const Harvest = (() => {
  const SERVICE_TYPES = ["Feature Service", "Map Image Service"];

  function classify(item) {
    const t = item.type;
    const keywords = (item.typeKeywords || []).join(" ");
    const url = item.url || "";
    const mapping = {
      "Feature Service": "Feature Service",
      "Map Service": "Map Image Service",
      "Web Map": "Web Map",
      "Web Scene": "Web Scene",
      "Web Experience": "Experience Builder",
      "Dashboard": "Dashboard",
      "StoryMap": "StoryMap",
      "Form": "Survey123 Form",
      "QuickCapture Project": "QuickCapture",
    };
    if (t in mapping) return mapping[t];
    if (t === "Web Mapping Application") {
      // WAB carries its own keyword; check it first so a WAB app is never
      // mislabeled. Everything else under this type is the Instant Apps /
      // configurable-app family — modern Instant Apps use the /apps/instant/
      // URL and a `configurableApp` keyword, NOT the older `instantApp` one.
      if (keywords.includes("Web AppBuilder")) return "Web AppBuilder";
      if (url.includes("/apps/instant/") || keywords.includes("instantApp") || keywords.includes("configurableApp")) {
        return "Instant App";
      }
      return "Web AppBuilder";
    }
    return "Other (" + t + ")";
  }

  async function retry(fn, attempts) {
    attempts = attempts || 3;
    for (let i = 1; i <= attempts; i++) {
      try { return await fn(); }
      catch (e) {
        if (i === attempts) throw e;
        await new Promise(res => setTimeout(res, 2000 * i));
      }
    }
  }

  function epochToDate(ms) {
    if (!ms) return null;
    const d = new Date(ms);
    const p = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function isAgolHost(url) {
    try { return new URL(url).hostname.toLowerCase().endsWith(".arcgis.com"); }
    catch (e) { return false; }
  }

  async function rest(session, url, params) {
    const resp = await arcgisRest.request(url, {
      authentication: session,
      httpMethod: "GET",
      params: Object.assign({f: "json"}, params || {}),
    });
    if (resp && resp.error) throw new Error(resp.error.message || "AGOL error");
    return resp;
  }

  // The /data endpoint returns an item's raw data document, which is an EMPTY
  // body for items that have none. arcgisRest's JSON parse throws "Unexpected
  // end of JSON input" on that. Read it raw and tolerate empty / non-JSON,
  // returning null to mirror Python's item.get_data() — the parsers then
  // report it gracefully instead of the harvest aborting the item.
  async function fetchItemData(session, dataUrl) {
    const resp = await arcgisRest.request(dataUrl, {
      authentication: session,
      httpMethod: "GET",
      rawResponse: true,
    });
    const text = await resp.text();
    if (!text || !text.trim()) return null;
    try { return JSON.parse(text); }
    catch (e) { return null; }
  }

  async function recordCount(session, serviceBase, layerId) {
    try {
      const r = await retry(() => rest(session, serviceBase + "/" + layerId + "/query",
        {where: "1=1", returnCountOnly: "true"}));
      return typeof r.count === "number" ? r.count : null;
    } catch (e) {
      return null;
    }
  }

  function addWarning(node, message) {
    node.parseWarning = node.parseWarning ? node.parseWarning + "; " + message : message;
  }

  async function makeNode(session, restRoot, orgUrl, item, external) {
    const node = {
      id: item.id,
      title: item.title || item.id,
      type: classify(item),
      owner: item.owner || null,
      created: epochToDate(item.created),
      modified: epochToDate(item.modified),
      sharing: item.access || null,
      url: orgUrl + "/home/item.html?id=" + item.id,
      external: !!external,
      layers: [],
      parseWarning: null,
    };
    if (SERVICE_TYPES.includes(node.type) && item.url) {
      if (isAgolHost(item.url)) {
        try {
          const svc = await retry(() => rest(session, item.url));
          const base = item.url.replace(/\/+$/, "");
          const layers = [];
          for (const l of (svc.layers || []))
            layers.push({name: l.name, index: l.id, isTable: false,
                         recordCount: await recordCount(session, base, l.id)});
          for (const t of (svc.tables || []))
            layers.push({name: t.name, index: t.id, isTable: true,
                         recordCount: await recordCount(session, base, t.id)});
          node.layers = layers;
        } catch (e) {
          addWarning(node, "could not list layers: " + e.message);
        }
      } else {
        addWarning(node, "layer list unavailable in browser for non-AGOL host");
      }
    }
    return node;
  }

  async function refsFor(session, restRoot, item, nodeType) {
    const dataUrl = restRoot + "/content/items/" + item.id + "/data";
    if (nodeType === "Web Map" || nodeType === "Web Scene") {
      return Parsers.parseWebmap(await retry(() => fetchItemData(session, dataUrl)));
    }
    if (nodeType === "Experience Builder") {
      return Parsers.parseExbWithFallback(await retry(() => fetchItemData(session, dataUrl)));
    }
    if (["Dashboard", "Web AppBuilder", "Instant App", "StoryMap", "QuickCapture"].includes(nodeType)) {
      // QuickCapture stores its backing feature-service references in the
      // project JSON (no reliable item-relationship endpoint), so the same
      // deep-scan used for app configs finds its service URLs.
      return Parsers.parseGenericApp(await retry(() => fetchItemData(session, dataUrl)));
    }
    if (nodeType === "Survey123 Form" ||
        (SERVICE_TYPES.includes(nodeType) && (item.typeKeywords || []).includes("View Service"))) {
      const relType = nodeType === "Survey123 Form" ? "Survey2Service" : "Service2Service";
      const kind = nodeType === "Survey123 Form" ? "form-submits-to" : "view-of";
      const rel = await retry(() => rest(session,
        restRoot + "/content/items/" + item.id + "/relatedItems",
        {relationshipType: relType, direction: "forward"}));
      const refs = (rel.relatedItems || []).map(r =>
        ({kind: kind, item_id: r.id, url: null, layer_index: null}));
      return [refs, []];
    }
    return [[], []];
  }

  function restRootOf(session) {
    return ((session && session.portal) || "https://www.arcgis.com/sharing/rest").replace(/\/+$/, "");
  }

  async function listGroups(session) {
    const restRoot = restRootOf(session);
    const self = await rest(session, restRoot + "/community/self");
    return (self.groups || []).map(g => ({id: g.id, title: g.title}))
      .sort((a, b) => (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1));
  }

  async function orgUrlOf(session, restRoot) {
    const portal = await rest(session, restRoot + "/portals/self");
    if (portal.urlKey && portal.customBaseUrl) {
      return "https://" + portal.urlKey + "." + portal.customBaseUrl;
    }
    return "https://www.arcgis.com";
  }

  async function groupItems(session, restRoot, groupId) {
    const items = [];
    let start = 1;
    for (;;) {
      const page = await retry(() => rest(session,
        restRoot + "/content/groups/" + groupId, {num: 100, start: start}));
      items.push(...(page.items || []));
      if (!page.nextStart || page.nextStart === -1) break;
      start = page.nextStart;
    }
    return items;
  }

  async function harvest(session, group, progress) {
    const restRoot = restRootOf(session);
    const orgUrl = await orgUrlOf(session, restRoot);
    const today = epochToDate(Date.now());
    const items = await retry(() => groupItems(session, restRoot, group.id));
    const groupIds = new Set(items.map(it => it.id));
    const nodes = {};
    const warnings = [];
    const edges = [];
    const externals = {};

    const serviceRows = [];
    for (const it of items) {
      const node = await makeNode(session, restRoot, orgUrl, it, false);
      nodes[it.id] = node;
      if (node.parseWarning) warnings.push(node.title + ": " + node.parseWarning);
      if (SERVICE_TYPES.includes(node.type) && it.url) {
        serviceRows.push([it.id, node.title, it.url]);
      }
    }
    const [urlToId, urlWarnings] = Parsers.buildUrlLookup(serviceRows);
    warnings.push(...urlWarnings);

    let i = 0;
    for (const it of items) {
      i++;
      const node = nodes[it.id];
      if (progress) progress(i, items.length, node.title);
      let refs, parseWarnings;
      try {
        [refs, parseWarnings] = await refsFor(session, restRoot, it, node.type);
      } catch (e) {
        addWarning(node, "relationships could not be read: " + e.message);
        warnings.push(node.title + ": " + e.message);
        continue;
      }
      for (const w of parseWarnings) {
        addWarning(node, w);
        warnings.push(node.title + ": " + w);
      }
      const [newEdges, newExternals] = Parsers.resolveRefs(it.id, refs, groupIds, urlToId);
      edges.push(...newEdges);
      for (const ext of newExternals) {
        if (!(ext.id in externals)) externals[ext.id] = ext;
      }
    }

    for (const extId of Object.keys(externals)) {
      if (extId in nodes) continue;
      const ext = externals[extId];
      let node = null;
      if (ext.item_id) {
        try {
          const item = await rest(session, restRoot + "/content/items/" + ext.item_id);
          if (item && item.id) node = await makeNode(session, restRoot, orgUrl, item, true);
        } catch (e) { node = null; }
      }
      if (!node) {
        node = {id: ext.id, title: ext.url || ext.item_id || ext.id,
                type: "External Service", owner: null, created: null, modified: null,
                sharing: null, url: null, external: true, layers: [],
                parseWarning: "referenced item could not be fetched"};
      }
      nodes[extId] = node;
    }

    return {
      meta: {group: group.title, org: orgUrl, generated: today, warnings: warnings},
      nodes: Object.values(nodes),
      edges: edges,
    };
  }

  return {harvest, listGroups, classify};
})();
