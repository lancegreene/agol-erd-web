// parsers.js — line-for-line port of erd_generator/parsers.py in the main
// AGOL_ERD_generator repo. Do not "improve" independently: change the Python,
// re-run export_web_assets.py, and make this match until test/tests.html is
// green (byte-equal against test/vectors.json).
"use strict";

const Parsers = (() => {
  const ITEM_ID_RE = /^[0-9a-f]{32}$/;

  function normalizeServiceUrl(url) {
    if (!url || typeof url !== "string") return null;
    let u = url.trim().toLowerCase().replace(/\/+$/, "");
    const i = u.lastIndexOf("/");
    if (i > 0) {
      const head = u.slice(0, i);
      const tail = u.slice(i + 1);
      if (head && /^[0-9]+$/.test(tail)) u = head;
    }
    return u || null;
  }

  function splitLayerIndex(url) {
    if (!url || typeof url !== "string") return [null, null];
    const u = url.replace(/\/+$/, "");
    const i = u.lastIndexOf("/");
    if (i > 0) {
      const head = u.slice(0, i);
      const tail = u.slice(i + 1);
      if (head && /^[0-9]+$/.test(tail)) return [head, parseInt(tail, 10)];
    }
    return [u, null];
  }

  function isItemId(value) {
    return typeof value === "string" && ITEM_ID_RE.test(value);
  }

  function ref(kind, itemId, url, layerIndex) {
    return {kind: kind,
            item_id: itemId !== undefined ? itemId : null,
            url: url !== undefined ? url : null,
            layer_index: layerIndex !== undefined ? layerIndex : null};
  }

  function parseWebmap(data) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return [[], ["item data is not a JSON object"]];
    }
    const layers = "operationalLayers" in data ? data.operationalLayers : [];
    if (!Array.isArray(layers)) return [[], ["operationalLayers is not a list"]];
    const refs = [];
    for (const layer of layers) {
      if (layer === null || typeof layer !== "object" || Array.isArray(layer)) continue;
      const itemId = isItemId(layer.itemId) ? layer.itemId : null;
      const url = typeof layer.url === "string" ? layer.url : null;
      const layerIndex = url ? splitLayerIndex(url)[1] : null;
      if (itemId || url) refs.push(ref("webmap-uses-service", itemId, url, layerIndex));
    }
    return [refs, []];
  }

  function parseExb(data) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return [[], ["item data is not a JSON object"]];
    }
    const sources = "dataSources" in data ? data.dataSources : {};
    if (sources === null || typeof sources !== "object" || Array.isArray(sources)) {
      return [[], ["dataSources is not an object"]];
    }
    const refs = [];
    for (const key of Object.keys(sources)) {
      const ds = sources[key];
      if (ds === null || typeof ds !== "object" || Array.isArray(ds) || !isItemId(ds.itemId)) continue;
      const kind = ds.type === "WEB_MAP" ? "app-uses-webmap" : "app-uses-item";
      const url = typeof ds.url === "string" ? ds.url : null;
      let layerIndex;
      if (Number.isInteger(ds.layerId)) layerIndex = ds.layerId;
      else if (url) layerIndex = splitLayerIndex(url)[1];
      else layerIndex = null;
      refs.push(ref(kind, ds.itemId, url, layerIndex));
    }
    return [refs, []];
  }

  const ID_KEYS = new Set(["itemid", "webmap", "mapitemid"]);
  const SERVICE_URL_RE = /\/(featureserver|mapserver|sceneserver)(\/|$)/i;
  const MAX_SCAN_DEPTH = 100;

  function parseGenericApp(data) {
    const isObj = data !== null && typeof data === "object";
    if (!isObj) return [[], ["item data is not a JSON object"]];
    const foundIds = [];   // [id, layerIndex] pairs
    const foundUrls = [];
    const warnings = [];

    function hasPair(id, li) {
      return foundIds.some(p => p[0] === id && p[1] === li);
    }

    function walk(obj, depth) {
      if (depth > MAX_SCAN_DEPTH) {
        if (!warnings.length) {
          warnings.push("deep scan stopped at depth " + MAX_SCAN_DEPTH + " — config nested too deeply");
        }
        return;
      }
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
        for (const key of Object.keys(obj)) {
          const value = obj[key];
          const k = key.toLowerCase();
          if (ID_KEYS.has(k) && isItemId(value)) {
            const sibling = obj.layerId;
            const li = Number.isInteger(sibling) ? sibling : null;
            if (!hasPair(value, li)) foundIds.push([value, li]);
          } else if (k === "url" && typeof value === "string") {
            if (SERVICE_URL_RE.test(value) && !foundUrls.includes(value)) foundUrls.push(value);
          } else {
            walk(value, depth + 1);
          }
        }
      } else if (Array.isArray(obj)) {
        for (const entry of obj) walk(entry, depth + 1);
      }
    }

    walk(data, 0);
    const refs = foundIds.map(p => ref("app-uses-item", p[0], null, p[1]));
    for (const u of foundUrls) refs.push(ref("app-uses-item", null, u, splitLayerIndex(u)[1]));
    return [refs, warnings];
  }

  function parseExbWithFallback(data) {
    let [refs, warns] = parseExb(data);
    if (!refs.length) {
      const [fallbackRefs, fallbackWarns] = parseGenericApp(data);
      if (fallbackRefs.length) {
        refs = fallbackRefs;
        warns = fallbackWarns.slice();
      } else {
        refs = fallbackRefs;
        warns = warns.concat(fallbackWarns);
      }
    }
    return [refs, warns];
  }

  function resolveRefs(sourceId, refs, groupIds, urlToId) {
    const edges = [], externals = [];
    const seen = new Set();
    for (const r of refs) {
      let target = null;
      const itemId = r.item_id;
      const url = r.url;
      if (itemId) {
        target = itemId;
      } else if (url) {
        const key = normalizeServiceUrl(url);
        target = Object.prototype.hasOwnProperty.call(urlToId, key) ? urlToId[key] : null;
        if (target === null) target = key;
      }
      const layerIndex = r.layer_index !== undefined && r.layer_index !== null ? r.layer_index : null;
      const seenKey = sourceId + " " + target + " " + layerIndex;
      if (target === null || target === sourceId || seen.has(seenKey)) continue;
      seen.add(seenKey);
      const edge = {from: sourceId, to: target, kind: r.kind};
      if (layerIndex !== null) edge.toLayer = layerIndex;
      edges.push(edge);
      if (!groupIds.has(target)) {
        externals.push({id: target,
                        item_id: itemId ? itemId : null,
                        url: !itemId ? (url !== undefined ? url : null) : null});
      }
    }
    return [edges, externals];
  }

  function buildUrlLookup(services) {
    const urlToId = {}, titles = {}, warnings = [];
    for (const [itemId, title, url] of services) {
      const key = normalizeServiceUrl(url);
      if (key === null) continue;
      if (Object.prototype.hasOwnProperty.call(urlToId, key) && urlToId[key] !== itemId) {
        warnings.push(title + " and " + titles[key] + " share service URL " + key +
                      " — edges may attach to the wrong one");
      }
      urlToId[key] = itemId;
      titles[key] = title;
    }
    return [urlToId, warnings];
  }

  return {normalizeServiceUrl, splitLayerIndex, isItemId,
          parseWebmap, parseExb, parseExbWithFallback, parseGenericApp,
          resolveRefs, buildUrlLookup};
})();
