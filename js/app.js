// app.js — UI state machine + client-side artifact generation.
"use strict";

// One-time setup: paste the Client ID of the OAuth application item you
// registered in AGOL (redirect URIs: this page's URL + http://localhost:8000/).
// PKCE has no secret; this id is public by design.
const OAUTH_CLIENT_ID = "PASTE_CLIENT_ID_HERE";

// OAuth popup callback: when ArcGIS redirects back to this page inside the
// sign-in popup, complete the PKCE exchange and hand the session to the
// opener window (whose Auth.signIn promise then resolves). The app UI must
// NOT initialize inside the popup.
if (window.opener && new URLSearchParams(window.location.search).has("code")) {
  arcgisRest.ArcGISIdentityManager.completeOAuth2({
    clientId: OAUTH_CLIENT_ID,
    redirectUri: window.location.origin + window.location.pathname,
    popup: true,
  });
} else (() => {
  const states = ["signedout", "picker", "progress", "result"];
  function show(state) {
    for (const s of states) {
      document.getElementById("state-" + s).classList.toggle("active", s === state);
    }
  }

  let groups = [];
  let selectedGroup = null;
  let lastGraph = null;
  let lastHtmlBlobUrl = null;

  function safeName(s) {
    return (String(s).replace(/[^\w\- ]/g, "").trim().replace(/ /g, "_")) || "group";
  }

  function download(filename, content, type) {
    const blob = content instanceof Blob ? content : new Blob([content], {type: type});
    const a = document.createElement("a");
    a.download = filename;
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function buildViewerHtml(graph) {
    const [tpl, lib] = await Promise.all([
      fetch("assets/template.html").then(r => r.text()),
      fetch("assets/vis-network.min.js").then(r => r.text()),
    ]);
    const graphJson = JSON.stringify(graph).replace(/<\//g, "<\\/");
    // function replacements: the vis lib contains `$&`-style sequences that a
    // string replacement would corrupt.
    return tpl.replace("/*__VIS_NETWORK_JS__*/", () => lib)
              .replace("/*__GRAPH_JSON__*/null", () => graphJson);
  }

  function renderGroupList(filter) {
    const list = document.getElementById("groupList");
    list.textContent = "";
    const f = (filter || "").trim().toLowerCase();
    for (const g of groups) {
      if (f && !g.title.toLowerCase().includes(f)) continue;
      const div = document.createElement("div");
      div.textContent = g.title;
      if (selectedGroup && selectedGroup.id === g.id) div.className = "selected";
      div.addEventListener("click", () => {
        selectedGroup = g;
        document.getElementById("generateBtn").disabled = false;
        renderGroupList(filter);
      });
      list.appendChild(div);
    }
    if (!list.children.length) {
      const div = document.createElement("div");
      div.className = "muted";
      div.textContent = "no groups match";
      list.appendChild(div);
    }
  }

  document.getElementById("signinBtn").addEventListener("click", async () => {
    const err = document.getElementById("authError");
    err.style.display = "none";
    if (OAUTH_CLIENT_ID === "PASTE_CLIENT_ID_HERE") {
      err.textContent = "Setup needed: register an OAuth app in AGOL and paste its Client ID into js/app.js (see README).";
      err.style.display = "block";
      return;
    }
    try {
      const session = await Auth.signIn(OAUTH_CLIENT_ID);
      document.getElementById("whoami").textContent = session.username || "(signed in)";
      groups = await Harvest.listGroups(session);
      selectedGroup = null;
      document.getElementById("generateBtn").disabled = true;
      renderGroupList("");
      show("picker");
    } catch (e) {
      err.textContent = "Sign-in did not complete: " + (e && e.message ? e.message : e);
      err.style.display = "block";
    }
  });

  document.getElementById("signoutLink").addEventListener("click", ev => {
    ev.preventDefault();
    Auth.signOut();
    show("signedout");
  });

  document.getElementById("groupFilter").addEventListener("input", ev => {
    renderGroupList(ev.target.value);
  });

  document.getElementById("generateBtn").addEventListener("click", async () => {
    if (!selectedGroup || !Auth.current()) return;
    document.getElementById("pickerError").style.display = "none";
    document.getElementById("harvestGroupName").textContent = selectedGroup.title;
    document.getElementById("barFill").style.width = "0";
    document.getElementById("progressLine").textContent = "";
    show("progress");
    try {
      const graph = await Harvest.harvest(Auth.current(), selectedGroup, (done, total, title) => {
        document.getElementById("barFill").style.width = Math.round(100 * done / total) + "%";
        document.getElementById("progressLine").textContent = done + "/" + total + " · " + title + " — parsing…";
      });
      if (!graph.nodes.length) {
        alertEmpty(selectedGroup.title);
        return;
      }
      lastGraph = graph;
      const html = await buildViewerHtml(graph);
      if (lastHtmlBlobUrl) URL.revokeObjectURL(lastHtmlBlobUrl);
      lastHtmlBlobUrl = URL.createObjectURL(new Blob([html], {type: "text/html"}));
      document.getElementById("viewerFrame").src = lastHtmlBlobUrl;
      const warn = document.getElementById("resultWarn");
      if (graph.meta.warnings.length) {
        warn.textContent = "⚠ " + graph.meta.warnings.length +
          " item(s) could not be fully parsed — details inside the viewer.";
        warn.style.display = "block";
      } else {
        warn.style.display = "none";
      }
      show("result");
    } catch (e) {
      const err = document.getElementById("authError");
      err.textContent = "Harvest failed: " + (e && e.message ? e.message : e) +
        " — sign in again and retry.";
      err.style.display = "block";
      show("signedout");
    }
  });

  function alertEmpty(title) {
    show("picker");
    const err = document.getElementById("pickerError");
    err.textContent = "Group '" + title + "' is empty — nothing to diagram.";
    err.style.display = "block";
  }

  function base() {
    return safeName(lastGraph.meta.group) + "_ERD_" + lastGraph.meta.generated;
  }

  document.getElementById("dlHtml").addEventListener("click", async () => {
    download(base() + ".html", await buildViewerHtml(lastGraph), "text/html");
  });
  document.getElementById("dlJson").addEventListener("click", () => {
    download(base() + ".json", JSON.stringify(lastGraph, null, 2), "application/json");
  });
  document.getElementById("dlMd").addEventListener("click", () => {
    download(base() + ".md", Report.buildMarkdown(lastGraph), "text/markdown");
  });
  document.getElementById("againBtn").addEventListener("click", () => {
    show("picker");
  });
})();
