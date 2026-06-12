# AGOL Group ERD Generator (web)

Static, serverless web app: sign in to ArcGIS Online, pick a group, and get an
interactive entity-relationship diagram of its contents — which services feed
which maps, which maps power which apps, which Survey123 forms submit where.
Download the result as a self-contained `.html`, a `.json` sidecar, or a `.md`
report.

**Privacy model:** everything runs in your browser. Authentication uses OAuth2
PKCE (no secrets exist); tokens live in memory only and all network traffic
goes exclusively to `*.arcgis.com`. This site's host (GitHub Pages) never sees
your token or your data.

## One-time setup (app owner)

1. In ArcGIS Online: Content → New item → Application → Other application.
2. On the item's Settings tab, add BOTH redirect URIs:
   - `https://<your-username>.github.io/agol-erd-web/`
   - `http://localhost:8000/`
3. Copy the Client ID into `OAUTH_CLIENT_ID` at the top of `js/app.js`.

## Develop locally

    python -m http.server 8000
    # then open http://localhost:8000/  (sign-in works via the localhost redirect URI)

## Parity tests

`test/tests.html` checks the JS ports against vectors generated from the
battle-tested Python implementation in the (private) main repo. Regenerate
assets + vectors from there with `scripts/export_web_assets.py` after any
parser/report/template change, then reload the test page — it must show 0 fail.

## Relationship to the CLI

The Python CLI (private repo) remains the full-featured tool: it additionally
produces `.docx` reports and run-to-run diffing. Sidecars downloaded from this
app are diffable by the CLI. Known divergence: in the browser, layer lists are
only fetched for `*.arcgis.com` services (cross-origin restrictions); affected
nodes carry a visible parse warning.
