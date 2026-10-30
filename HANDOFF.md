# Project handoff

Last verified: September 2, 2026 (America/Denver)

## Current state

- Repository: <https://github.com/rharder/activity-tracker>
- Default branch: `main`
- Baseline commit: `3d663464b409c9c34cc9d09245090fb59fdc60c0`
- Live site: <https://rharder.github.io/activity-tracker/>
- GitHub Pages source: GitHub Actions
- Deployment workflow: `.github/workflows/pages.yml`
- Latest deployment: successful on workflow run 1, attempt 2
- Deployment run: <https://github.com/rharder/activity-tracker/actions/runs/33708078520>

At the time of this handoff, local `main` and `origin/main` both pointed to the baseline commit and the working tree was clean before this handoff file was added. The live URL returned HTTP 200 and contained the expected `Daily Activity Tracker` page and service-worker registration.

## What was set up

The original untracked static application was moved from `previous-version/` into `site/`. Repository support files were added, including:

- `README.md` for development and deployment instructions
- `.gitignore`
- `.editorconfig`
- `site/.nojekyll`
- `.github/workflows/pages.yml` for automatic Pages deployments

The nominal 192-pixel PWA icon was corrected from 180×180 to 192×192. The service worker was also adjusted so its installation does not depend on Google Fonts being reachable, local PWA assets are cached, only GET requests are intercepted, and stale-while-revalidate work is kept alive with `event.waitUntil()`.

## Application architecture

This is a static web app with no package manager or build step. Optional Google/Firebase sync was added October 30, 2026; the pinned SDK loads only after opting in.

```text
site/
  index.html       Entire UI, CSS, and application JavaScript
  manifest.json    PWA metadata
  sw.js            Offline cache and fetch handling
  sync-state.js    Atomic local state and durable outbox
  cloud-sync.js    Optional Google sign-in and background transactions
  firebase-config.js  Public Firebase web configuration
  icon-192.png     PWA icon
  icon-512.png     PWA icon
```

Important implementation details:

- User data is always saved locally first. Optional sync stores a private document at `activityTrackers/{uid}` in the existing `kids-money-tracker-f24be` Firebase project; there is no mandatory account or authentication gate.
- State is stored under `habit_tracker_v1`, with a backward-compatible `_sync` field holding account binding, pending mutations, and the last server revision. State and outbox persist atomically. Legacy data requires no clearing or manual migration; JSON exports contain only the original app-state format.
- The local service-worker cache is named `activity-tracker-v8`. During deployment, the Pages workflow stamps both the footer and cache name with `v<run number>.<attempt>-<short commit SHA>`, so each published copy has a visible version and its own offline cache.
- The complete app shell is cache-first: poor or hanging connections never delay cached startup. Explicit update checks bypass the cache; only a successfully installed new worker replaces the complete shell. Firebase APIs/tokens are never cached by the service worker; only pinned public SDK scripts qualify for a separate optional cache.
- The app checks for updates on launch, foregrounding, and reconnecting; the footer also has a manual check. A new version prompts for reload rather than interrupting entry. On the first upgrade from the original v4/v5 or deployed v4.1 caches (which have no update UI), the service worker reloads open app windows once after activating. Saved activity data is untouched; iOS still needs to discover the new service worker before this migration can run.
- Relative asset paths are deliberate so the app works at the GitHub project path `/activity-tracker/`.
- Editing `site/` and pushing to `main` triggers an automatic deployment.

## Resume on another computer

```sh
git clone git@github.com:rharder/activity-tracker.git
cd activity-tracker
python3 -m http.server 8000 --directory site
```

Open <http://localhost:8000> for local development.

If the repository is already cloned:

```sh
git switch main
git pull --ff-only
```

### Continue with OpenCode

The repository root now contains `AGENTS.md`, which packages the durable agent context for OpenCode: architecture, invariants, development commands, verification, and deployment constraints. OpenCode loads this file automatically when started from the repository root. Keep `AGENTS.md` in Git so the same guidance travels with every clone.

The full Codex conversation is not stored in this repository. `HANDOFF.md`, `README.md`, Git history, and `AGENTS.md` are the portable development context. There was no unfinished implementation work when the OpenCode handoff was prepared.

The tracker's user data is separate from development context because it lives in browser `localStorage`. If that data should move too, use **Settings → Export JSON** on the old device and **Import JSON** on the new device. The exported `activity-tracker-backup*.json` file can contain personal activity history and is intentionally ignored by Git; transfer it privately rather than committing it.

## Useful verification commands

```sh
git status --short --branch
node --check site/sw.js
python3 -m json.tool site/manifest.json >/dev/null
git diff --check
curl --fail --location https://rharder.github.io/activity-tracker/
```

The first Pages workflow attempt failed because Pages had not yet been enabled. Pages was then configured to use GitHub Actions and the same run was rerun successfully. Do not create a second workflow from GitHub's suggested **Static HTML** template; the checked-in workflow is already the deployment source.

## Maintenance notes

- When changing cached application assets, increment `CACHE_NAME` in `site/sw.js` so installed clients receive the new cache.
- Test through an HTTP server rather than opening `index.html` directly; service workers do not run from `file://` URLs.
- Browser data transfers across devices only after opting into Google sync with the same account, or via private JSON export/import. Pending sync runs while the app is open; iOS may suspend it in the background.
- Keep deployable files within `site/`, because the Pages workflow uploads only that directory.
- `firestore.rules` is shared-project configuration: preserve all currently deployed money/permit/activity rules before any deployment. The older sibling repositories' rules may omit this app. See README for sync conflict semantics, account switching, security, and emulator checks.
