# Activity Tracker agent instructions

## Start here

- Read `README.md` for the basic development and deployment workflow.
- Read `HANDOFF.md` for the project history, architecture, and operational notes.
- Check `git status --short --branch` before editing and preserve unrelated user changes.

## Project shape

- This is an intentionally dependency-free static progressive web app. Do not add a package manager, framework, backend, or build step unless the user explicitly requests that architectural change.
- Deployable files live in `site/`. The GitHub Pages workflow uploads only that directory.
- `site/index.html` contains the application markup, CSS, and JavaScript.
- `site/manifest.json` contains PWA metadata.
- `site/sw.js` implements offline caching.
- User state is browser-local under the `localStorage` key `habit_tracker_v1`; there is no account system or server-side data store.

## Important invariants

- Keep application asset URLs relative so the site continues to work at the GitHub project path `/activity-tracker/`.
- When changing cached application assets or behavior, increment `CACHE_NAME` in `site/sw.js` so installed clients receive the update.
- Test through an HTTP server rather than `file://`; service workers require an HTTP origin (localhost is sufficient).
- Preserve compatibility with existing `habit_tracker_v1` data. If the stored-state shape changes, handle older saved data deliberately rather than silently discarding it.
- Treat `activity-tracker-backup*.json` as private user data. It is ignored by Git and must not be committed.

## Local development

Run from the repository root:

```sh
python3 -m http.server 8000 --directory site
```

Then open <http://localhost:8000>.

## Verification

Use the checks relevant to the change, and run all of these before handing off broad application or deployment changes:

```sh
node --check site/sw.js
python3 -m json.tool site/manifest.json >/dev/null
git diff --check
git status --short --branch
```

Also exercise the affected UI in a browser when behavior, layout, storage, import/export, or service-worker behavior changes.

## Deployment

- Pushing `main` triggers `.github/workflows/pages.yml` and publishes `site/` to <https://rharder.github.io/activity-tracker/>.
- GitHub Pages is already configured to use GitHub Actions. Do not add a second Pages workflow.
- Do not push, deploy, clear user data, or rewrite Git history unless the user requests it.
