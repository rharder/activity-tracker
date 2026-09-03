# Activity Tracker

A small, installable daily activity tracker that runs entirely in the browser. Data is stored locally on the device, and the progressive web app continues to work offline after its first successful load.

## Local development

The site has no build step or package dependencies. Serve the `site` directory with any static file server; for example:

```sh
python3 -m http.server 8000 --directory site
```

Then open <http://localhost:8000>. A local server is recommended because service workers are not available when opening `index.html` directly from the filesystem.

## Project structure

```text
site/                      Published static site
  index.html               Application markup, styles, and behavior
  manifest.json            PWA metadata
  sw.js                    Offline service worker
  icon-192.png             PWA icon
  icon-512.png             PWA icon
.github/workflows/pages.yml  GitHub Pages deployment
```

## Deployment

Every push to `main` deploys the contents of `site/` through GitHub Actions. The expected project site URL is:

<https://rharder.github.io/activity-tracker/>

In the repository's **Settings → Pages**, set **Source** to **GitHub Actions** if it is not selected already. The deployment can also be started manually from the **Actions** tab.

