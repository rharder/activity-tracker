"""Real CDN Firestore compat SDK + real emulator + app UI; fake identity only.

Run through firebase emulators:exec. No production documents are accessed.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import json
import os
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

if not os.environ.get('FIRESTORE_EMULATOR_HOST'):
    raise RuntimeError('Refusing to run without FIRESTORE_EMULATOR_HOST')
ROOT = Path(__file__).resolve().parent.parent
host, port = os.environ['FIRESTORE_EMULATOR_HOST'].split(':')


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
Thread(target=server.serve_forever, daemon=True).start()

try:
    with sync_playwright() as p:
        for engine in ('chromium', 'webkit'):
            browser = getattr(p, engine).launch(headless=True)
            pages = []
            errors = []
            uid = 'browser-' + engine
            for device in range(2):
                context = browser.new_context(viewport={'width': 390, 'height': 844})
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('requestfailed', lambda request: print('Request failed:', urlsplit(request.url).netloc, urlsplit(request.url).path, request.failure))
                page.goto(f'http://localhost:{server.server_port}/site/')
                page.locator('.sync-strip button').click()
                page.locator('#enableSyncButton').click()
                page.locator('#signInButton').wait_for(state='visible', timeout=45000)
                awaitable = f"""async () => {{
                  cloudController.destroy();
                  const app = firebase.initializeApp({{
                    apiKey:'demo-key', projectId:'demo-activity-tracker', appId:'demo-app'
                  }}, 'emulator-test');
                  const db = app.firestore();
                  db.useEmulator({json.dumps(host)}, {int(port)}, {{mockUserToken:{{
                    sub:{json.dumps(uid)}, user_id:{json.dumps(uid)}, email:'test@example.com'
                  }}}});
                  window.testDatabase = db;
                  const {{createCloudSync}} = await import('./cloud-sync.js');
                  const sdk = {{
                    initializeApp: () => app, getAuth: () => ({{}}), getFirestore: () => db,
                    setPersistence: async () => {{}}, browserLocalPersistence: {{}},
                    GoogleAuthProvider: firebase.auth.GoogleAuthProvider,
                    onAuthStateChanged: (auth, callback) => {{
                      queueMicrotask(() => callback({{uid:{json.dumps(uid)}, email:'test@example.com'}}));
                      return () => {{}};
                    }},
                    doc: (db, collection, uid) => db.collection(collection).doc(uid),
                    onSnapshot: (ref, options, next, error) => ref.onSnapshot(options, next, error),
                    getDocFromServer: ref => ref.get({{source:'server'}}),
                    runTransaction: (db, update, options) => db.runTransaction(update, options)
                  }};
                  cloudController = await createCloudSync({{
                    store:syncStore, onState:applyCloudState, canApplyRemote:canApplyCloudState,
                    onStatus:renderSyncStatus
                  }}, async () => sdk);
                }}"""
                page.evaluate(awaitable)
                try:
                    page.wait_for_function('cloudStatus.kind === "synced"')
                except Exception:
                    print('Emulator diagnostic:', page.evaluate('({status:cloudStatus, pending:syncStore.meta.pending.length})'))
                    raise
                pages.append(page)
            first, second = pages
            first.evaluate("document.getElementById('addHabitInput').value='Real SDK test'; addHabit()")
            first.wait_for_function('syncStore.meta.pending.length === 0')
            second.wait_for_function('state.habits.length === 1')
            habit = first.evaluate('state.habits[0].id')
            # Device two remains editable with Firestore explicitly offline.
            second.evaluate("Object.defineProperty(navigator,'onLine',{value:false,configurable:true}); window.dispatchEvent(new Event('offline')); testDatabase.disableNetwork()")
            second.evaluate(f"increment({json.dumps(habit)}); increment({json.dumps(habit)})")
            assert second.evaluate('syncStore.meta.pending.length') == 2
            first.evaluate(f"increment({json.dumps(habit)})")
            first.wait_for_function('syncStore.meta.pending.length === 0')
            second.evaluate("Object.defineProperty(navigator,'onLine',{value:true,configurable:true}); testDatabase.enableNetwork(); window.dispatchEvent(new Event('online'))")
            for page in pages:
                page.wait_for_function(f"getCount(dateKey(viewDate),{json.dumps(habit)}) === 3 && syncStore.meta.pending.length === 0")
            assert not errors, errors
            print(f'{engine}: actual CDN compat SDK, boolean snapshots, real Firestore transactions/listeners, two-device offline merge PASS')
            browser.close()
finally:
    server.shutdown()
