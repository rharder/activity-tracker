"""Optional browser checks: python3 tests/browser_sync.py (requires Playwright)."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import json
import time
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DAY = '2026-10-30'
FIXTURE = {
    'habits': [{'id': 'h_one', 'name': 'Walk', 'color': '#e8834a', 'created': DAY}],
    'data': {DAY: {'h_one': 3}}, 'weekStart': 0, 'theme': 'dark'
}


class Handler(SimpleHTTPRequestHandler):
    stall_pages = False

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.endswith('/cloud-sync.js'):
            source = (ROOT / 'site/cloud-sync.js').read_text().replace(
                'sdkLoader = loadFirebase', 'sdkLoader = async () => window.fakeFirebase')
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript')
            self.end_headers()
            self.wfile.write(source.encode())
        elif Handler.stall_pages and (self.path.endswith('/site/') or self.path.endswith('index.html')):
            time.sleep(15)
            self.send_error(503)
        else:
            super().do_GET()


server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}/site/'
fake = (ROOT / 'tests/fake-firebase.js').read_text()

try:
    with sync_playwright() as p:
        for engine in ('chromium', 'webkit'):
            browser = getattr(p, engine).launch(headless=True)
            context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
            context.route('**/fonts.googleapis.com/**', lambda route: route.abort())
            context.add_init_script(fake)
            context.add_init_script(f"""
                if (!localStorage.getItem('sync_test_seeded')) {{
                  localStorage.setItem('habit_tracker_v1', {json.dumps(json.dumps(FIXTURE))});
                  localStorage.setItem('sync_test_seeded', 'true');
                }}
            """)
            page = context.new_page()
            errors, requests = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: requests.append(request.url))
            page.goto(url)
            page.wait_for_function('navigator.serviceWorker.controller !== null')
            assert page.locator('.habit-name').inner_text() == 'Walk'
            assert not any('firebasejs' in request for request in requests)
            assert page.evaluate('state.data["2026-10-30"].h_one') == 3

            # A network that hangs must not delay the cached shell or local data.
            Handler.stall_pages = True
            started = time.monotonic()
            page.reload(wait_until='domcontentloaded')
            page.locator('.habit-name').wait_for()
            assert time.monotonic() - started < 3
            Handler.stall_pages = False
            print(f'{engine}: cached startup under a hanging network is immediate; local-only mode makes no Firebase request')

            page.locator('.sync-strip button').click()
            page.locator('#enableSyncButton').click()
            page.locator('#signInButton').wait_for(state='visible')
            page.locator('#signInButton').click()
            page.wait_for_function('syncStore.meta.pending.length === 0 && syncTest.remote !== null')
            assert page.evaluate('syncTest.remote.state.data["2026-10-30"].h_one') == 3

            # A delayed upload must not block a second edit or acknowledge it early.
            page.evaluate('syncTest.deferWrites = true; increment("h_one")')
            page.wait_for_function('syncTest.releases.length > 0')
            page.evaluate('increment("h_one")')
            assert page.evaluate('state.data["2026-10-30"].h_one') == 5
            assert page.evaluate('JSON.parse(localStorage.getItem("habit_tracker_v1"))._sync.pending.length') == 2
            assert 'Synced' not in page.locator('#syncSummary').inner_text()
            page.evaluate('syncTest.release()')
            page.wait_for_function('syncStore.meta.pending.length === 0')
            assert page.evaluate('syncTest.remote.state.data["2026-10-30"].h_one') == 5
            print(f'{engine}: delayed acknowledgements preserve newer local edits; status waits for acknowledgement')

            # Incoming changes must not destroy a name being edited.
            page.evaluate('startEditHabit("h_one")')
            page.locator('.mh-name-input').fill('My local rename')
            page.evaluate('''
              const next = structuredClone(syncTest.remote);
              next.revision++;
              next.state.data['2026-10-30'].h_one += 4;
              syncTest.emit(next);
            ''')
            assert page.locator('.mh-name-input').input_value() == 'My local rename'
            page.locator('.mh-name-input').press('Enter')
            page.wait_for_function('state.data["2026-10-30"].h_one === 9 && syncStore.meta.pending.length === 0')
            assert page.evaluate('state.habits[0].name') == 'My local rename'

            # Denied access must keep the outbox, never silently roll back the edit.
            page.evaluate('syncTest.error = "permission-denied"; increment("h_one")')
            page.wait_for_function('cloudStatus.kind === "error"')
            assert page.evaluate('state.data["2026-10-30"].h_one') == 10
            assert page.evaluate('syncStore.meta.pending.length') == 1
            page.evaluate('syncTest.error = null; cloudController.syncNow()')
            page.wait_for_function('syncStore.meta.pending.length === 0')

            # Export remains a plain, dated, backward-compatible backup.
            with page.expect_download() as event:
                page.get_by_role('button', name='Export JSON', exact=True).click()
            download = event.value
            backup = json.loads(Path(download.path()).read_text())
            assert '_sync' not in backup
            assert download.suggested_filename.startswith('activity-tracker-backup-')
            assert backup['data'][DAY]['h_one'] == 10

            # Turn sync off; edits still queue against Alice, not a future account.
            page.locator('#disconnectSyncButton').click()
            page.evaluate('increment("h_one")')
            assert page.evaluate('syncStore.meta.pending.length') == 1
            assert not page.evaluate('syncStore.meta.enabled')
            page.locator('#enableSyncButton').click()
            page.locator('#signInButton').wait_for(state='visible')
            page.evaluate('syncTest.changeUser({uid:"bob", email:"bob@example.com"})')
            page.wait_for_function('cloudStatus.kind === "mismatch"')
            assert page.evaluate('syncStore.meta.uid') == 'alice'
            assert page.evaluate('state.data["2026-10-30"].h_one') == 11
            page.evaluate('syncTest.changeUser({uid:"alice", email:"alice@example.com"})')
            page.wait_for_function('syncStore.meta.pending.length === 0')
            cloud = page.evaluate('syncTest.remote')

            # Disconnect the network, edit, and reload the installed/cached copy.
            # Playwright WebKit's offline emulation fails navigations internally
            # before dispatching them to a service worker. A stalled origin tests
            # the same app fallback without relying on that automation limitation.
            context.set_offline(engine == 'chromium')
            if engine == 'webkit':
                page.evaluate("Object.defineProperty(navigator, 'onLine', {value:false, configurable:true}); window.dispatchEvent(new Event('offline'))")
            page.evaluate('increment("h_one")')
            assert page.evaluate('state.data["2026-10-30"].h_one') == 12
            Handler.stall_pages = engine == 'webkit'
            page.reload(wait_until='domcontentloaded')
            page.wait_for_function('typeof state !== "undefined"')
            assert page.evaluate('state.data["2026-10-30"].h_one') == 12
            assert page.evaluate('syncStore.meta.pending.length') == 1
            page.evaluate('syncTest.remote = ' + json.dumps(cloud))
            Handler.stall_pages = False
            context.set_offline(False)
            if engine == 'webkit':
                page.evaluate("Object.defineProperty(navigator, 'onLine', {value:true, configurable:true}); window.dispatchEvent(new Event('online'))")
            page.wait_for_function('typeof cloudController !== "undefined" && cloudController !== null')
            page.evaluate('syncTest.changeUser({uid:"alice", email:"alice@example.com"})')
            page.wait_for_function('syncStore.meta.pending.length === 0')
            assert page.evaluate('syncTest.remote.state.data["2026-10-30"].h_one') == 12
            assert not errors, errors
            print(f'{engine}: remote edits respect open forms; denied access, dated backup, sign-out/account isolation, offline reload and eventual retry PASS')
            context.close()
            browser.close()
finally:
    Handler.stall_pages = False
    server.shutdown()
