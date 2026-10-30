# Activity Tracker

A small, installable daily activity tracker that runs in the browser. Data saves locally immediately, and the app continues to work offline after its first successful load. Optional Google sync keeps a private copy across your devices without blocking local use.

## Development prerequisites

- Python 3 (or another static HTTP server) to preview the app.
- Git for source control.
- Node.js for JavaScript syntax checks only; there are no npm packages to install.
- GitHub CLI (`gh`), optionally, to inspect repository settings and deployment runs.

Local-only use needs no account, API key setup, backend setup, or `.env` file. Optional sync uses the existing Firebase project; its committed web configuration is public, and Firestore rules enforce private account access. GitHub authentication is only needed for repository operations. Check existing access with `gh auth status` and `git ls-remote --heads origin main`; never put credentials in the repository. Google Fonts is optional for typography and requires no credentials.

## Local development

The site has no build step or package installation. Serve the `site` directory with any static file server; for example:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory site
```

Then open <http://localhost:8000>. A local server is recommended because service workers are not available when opening `index.html` directly from the filesystem.

### Development over SSH

When the repository and development server are on `piglet`, run the server command above from the repository directory on that machine. In a terminal on **your own computer**, open a tunnel (use your usual SSH username or host alias if different):

```sh
ssh -N -o ExitOnForwardFailure=yes -L 8000:127.0.0.1:8000 piglet
```

Keep the tunnel running and open <http://localhost:8000> in your own browser, not a browser on piglet. The server listens only on piglet's loopback interface; no public port or firewall change is needed. Stop a foreground server or tunnel with Ctrl-C.

If local port 8000 is busy, use `-L 8001:127.0.0.1:8000` and open <http://localhost:8001>. Browser data is separate for each origin (including port), and the development origin is separate from the live site. Keep a consistent local URL to retain development data; transfer real activity data only with a private JSON export/import when desired.

### Basic checks

```sh
node --check site/sw.js
node --check site/sync-state.js
node --check --input-type=module < site/cloud-sync.js
node --test tests/sync-state.test.js
python3 -m json.tool site/manifest.json >/dev/null
git diff --check
git status --short --branch
```

Also test affected UI in your browser. When changing cached application assets or behavior, increment `CACHE_NAME` in `site/sw.js` and preserve compatibility with existing `habit_tracker_v1` saved data.

## Optional Google sync

In **Settings → Optional Google Sync**, choose **Enable Google sync**, then **Continue with Google** once the sign-in button is ready. Choose the same Google account on each device. No family sharing is enabled: each account has its own private tracker, separate from the money and permit apps.

- The app renders `localStorage` immediately and saves edits there synchronously, even if Firebase is slow, unavailable, or not signed in. SDK downloads and sync never gate the UI.
- On first connection, existing activities are combined by ID. Matching counts use the larger value, not their sum, so importing the same backup on two devices does not double the initial history. Once linked, offline counter changes merge additively through server transactions.
- A durable, account-bound outbox survives closing, reloading, app updates, poor connections, and rejected uploads. Retries use operation sequence numbers so acknowledgements cannot double-count edits. “Synced” requires a server response, not just a network signal.
- Returning to the app, reconnecting, or choosing **Sync now** retries. Sync can only run while the app is open; iOS does not guarantee work after closing or suspending a PWA.
- **Turn sync off** keeps all local data. Edits to an already-linked tracker remain queued for that account if you reconnect later. A different signed-in account cannot receive those edits silently. **Switch tracker** archives the old tracker and its queue locally, then opens the other account's tracker; switching back restores its local copy.
- Other-device changes do not interrupt an open input or rename. Renames/settings use transaction commit order for conflicting edits to the same field. Deleting an activity also deletes its counts; stale offline counter changes do not resurrect it.
- Import and reset intentionally replace the synced tracker as well as the local copy; confirmations explain this. JSON backups omit account/outbox metadata and include the local date and time in their filenames. Keep regular private backups: browser storage can be evicted, and clearing it removes unsynced edits and archived accounts.

### Firebase administration

The project is `kids-money-tracker-f24be`, with one document per user at `activityTrackers/{uid}`. The optional SDK is pinned to Firebase 12.18.0 and downloaded only after opting in; its public script files can be cached for subsequent offline starts. Authentication uses a named Firebase app so signing out here does not sign out the other apps. Google sign-in must authorize `rharder.github.io` and `localhost`; both are already configured.

`firestore.rules` contains the **combined rules for all three apps**. Before deploying any rules, compare against the currently published rules and preserve changes made by other apps. Deploy only the rules, never hosting or other services:

```sh
firebase deploy --only firestore:rules --project kids-money-tracker-f24be
```

Older copies of the money/permit repositories' rules do not include the new activity-tracker block. Deploying one unchanged would disable this tracker's sync; merge all current rule blocks first. No service-account key is required. Never commit or print Firebase CLI tokens; its JSON login-status output includes credentials.

### Optional integration checks

`python3 tests/browser_sync.py` uses an already installed Python Playwright environment and its Chromium/WebKit browsers. It tests local-only use, hanging-network startup, delayed/denied uploads, open-form protection, account isolation, backups, and offline retries using a deterministic Firebase double. It never accesses production data.

`tests/firebase-emulator.test.js` additionally checks real concurrent Firestore transactions and owner/viewer security rules with fictional data. It refuses to run without `FIRESTORE_EMULATOR_HOST`. With Firebase CLI, Java 21, and a separately installed Firebase JS SDK available, run:

```sh
FIREBASE_SDK_PATH=/absolute/path/to/node_modules/firebase \
  firebase emulators:exec --only firestore --project demo-activity-tracker \
  --config firebase.emulator.json 'node --test tests/firebase-emulator.test.js'
```

These test tools are optional developer tools, not application dependencies or a build step.

For a browser-to-emulator check using the actual CDN SDK, run the same emulator command with `python3 tests/browser_emulator.py` instead. It uses fictional identities and a `demo-` project, never production documents. This also requires an internet connection to load the optional SDK and Python Playwright browsers.

## Project structure

```text
site/                      Published static site
  index.html               Application markup, styles, and behavior
  manifest.json            PWA metadata
  sw.js                    Offline service worker
  sync-state.js            Local state and durable sync outbox
  cloud-sync.js            Optional background Firebase adapter
  firebase-config.js       Public Firebase web configuration
  icon-192.png             PWA icon
  icon-512.png             PWA icon
.github/workflows/pages.yml  GitHub Pages deployment
```

## Deployment

Every push to `main` deploys the contents of `site/` through GitHub Actions. The expected project site URL is:

<https://rharder.github.io/activity-tracker/>

In the repository's **Settings → Pages**, set **Source** to **GitHub Actions** if it is not selected already. The deployment can also be started manually from the **Actions** tab.

## License

Application code is released into the public domain under the [Unlicense](LICENSE). Google's optional Firebase SDK retains its own license.
