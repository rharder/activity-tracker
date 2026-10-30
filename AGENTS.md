# Activity Tracker agent instructions

## Start here

- Read `README.md` for the basic development and deployment workflow.
- Read `HANDOFF.md` for the project history, architecture, and operational notes.
- Check `git status --short --branch` before editing and preserve unrelated user changes.

## Project shape

- This is a static progressive web app with no package manager or build step. Optional Google/Firebase sync loads its pinned SDK from Google's CDN only after opting in. Do not introduce a framework, package installation, or additional backend unless explicitly requested.
- Deployable files live in `site/`. The GitHub Pages workflow uploads only that directory.
- `site/index.html` contains the application markup, CSS, and JavaScript.
- `site/manifest.json` contains PWA metadata.
- `site/sw.js` implements offline caching.
- User state is always browser-local under `habit_tracker_v1`. An optional, private-per-account Firestore copy lives in `activityTrackers/{uid}` in the shared `kids-money-tracker-f24be` project.
- `site/sync-state.js` owns the atomic local state/outbox, and `site/cloud-sync.js` runs optional authentication and background transactions. `site/firebase-config.js` contains public web configuration, not credentials.

## Important invariants

- Keep application asset URLs relative so the site continues to work at the GitHub project path `/activity-tracker/`.
- When changing cached application assets or behavior, increment `CACHE_NAME` in `site/sw.js` so installed clients receive the update.
- Test through an HTTP server rather than `file://`; service workers require an HTTP origin (localhost is sufficient).
- Preserve compatibility with existing `habit_tracker_v1` data. If the stored-state shape changes, handle older saved data deliberately rather than silently discarding it.
- Never await authentication, SDK downloads, cloud reads, or cloud writes before rendering local data or accepting edits. Keep navigation cache-first, even on a hanging connection.
- Persist state and its `_sync` outbox together before starting a cloud write. Remove pending edits only after a server acknowledgement; use transactions and per-actor operation sequences to prevent retries from doubling counts. Exports omit `_sync` metadata.
- Bind queued edits to their original account. Never upload one account's local tracker to a different account automatically.
- Firebase rules are SHARED with the money and permit apps. Preserve all currently deployed rules when adding changes. Older sibling rules files may not include this tracker; do not deploy them blindly. Never log CLI credentials (in particular, `firebase login:list --json` includes tokens).
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
node --check site/sync-state.js
node --check --input-type=module < site/cloud-sync.js
node --test tests/sync-state.test.js
python3 -m json.tool site/manifest.json >/dev/null
git diff --check
git status --short --branch
```

Also exercise the affected UI in a browser when behavior, layout, storage, import/export, or service-worker behavior changes.

## Deployment

- Pushing `main` triggers `.github/workflows/pages.yml` and publishes `site/` to <https://rharder.github.io/activity-tracker/>.
- GitHub Pages is already configured to use GitHub Actions. Do not add a second Pages workflow.
- Do not push, deploy, clear user data, or rewrite Git history unless the user requests it.
