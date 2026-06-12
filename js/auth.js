// auth.js — OAuth2 PKCE via Esri's vendored arcgis-rest-request UMD
// (global `arcgisRest`). Tokens live in memory only — never persisted.
"use strict";

const Auth = (() => {
  let session = null;

  async function signIn(clientId) {
    session = await arcgisRest.ArcGISIdentityManager.beginOAuth2({
      clientId: clientId,
      redirectUri: window.location.origin + window.location.pathname,
      popup: true,
    });
    return session;
  }

  function signOut() {
    if (session) {
      try { arcgisRest.ArcGISIdentityManager.destroy(session); } catch (e) { /* best-effort */ }
    }
    session = null;
  }

  function current() { return session; }

  return {signIn, signOut, current};
})();
