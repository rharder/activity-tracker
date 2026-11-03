"""Rapid real touch input with local saves and racing sync acknowledgements.

Run: python3 tests/rapid_taps.py (requires installed Playwright browsers).
Only fictional data and a Firebase double are used.
"""
from datetime import date, datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import json
import time
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DAY = '2026-11-03'
HABIT = 'h_19'
fixture = {
    'habits': [{'id': f'h_{i}', 'name': f'Activity {i + 1}', 'color': '#e8834a', 'created': '2026-01-01'} for i in range(20)],
    'data': {(date.fromisoformat(DAY) - timedelta(days=i)).isoformat(): {f'h_{h}': 1 for h in range(20)} for i in range(1, 181)},
    'theme': 'dark', 'weekStart': 0
}


class Handler(SimpleHTTPRequestHandler):
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
        else:
            super().do_GET()


server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
Thread(target=server.serve_forever, daemon=True).start()

try:
    with sync_playwright() as p:
        for engine in ('chromium', 'webkit'):
            browser = getattr(p, engine).launch(headless=True)
            context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
            context.route('**/fonts.googleapis.com/**', lambda route: route.abort())
            context.add_init_script((ROOT / 'tests/fake-firebase.js').read_text())
            context.add_init_script(f"localStorage.setItem('habit_tracker_v1', {json.dumps(json.dumps(fixture))})")
            page = context.new_page()
            page.clock.set_fixed_time(datetime(2026, 11, 3, 18, tzinfo=timezone.utc))
            errors, navigations = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('framenavigated', lambda frame: navigations.append(frame.url) if frame == page.main_frame else None)
            page.goto(f'http://127.0.0.1:{server.server_port}/site/')
            plus = page.locator(f'[data-habit-id="{HABIT}"] .inc')
            minus = page.locator(f'[data-habit-id="{HABIT}"] .dec')

            def position(button):
                button.scroll_into_view_if_needed()
                box = button.bounding_box()
                return box['x'] + box['width'] / 2, box['y'] + box['height'] / 2

            x, y = position(plus)
            page.evaluate(f"window.originalButton = document.querySelector('[data-habit-id=\"{HABIT}\"] .inc')")

            def tap(expected, x=x, y=y):
                # Fixed coordinates deliberately bypass locator auto-waiting for
                # a replacement button or a restarted entrance animation.
                page.touchscreen.tap(x, y)
                result = page.evaluate(f"""({{
                  saved: JSON.parse(localStorage.getItem('habit_tracker_v1')).data['{DAY}']?.{HABIT} || 0,
                  displayed: document.querySelector('[data-habit-id="{HABIT}"] .counter-value').textContent,
                  stable: originalButton.isConnected
                }})""")
                assert result == {'saved': expected, 'displayed': str(expected), 'stable': True}, result

            started = time.monotonic()
            for count in range(1, 21):
                tap(count)
            print(f'{engine}: 20 local-only taps in {time.monotonic() - started:.2f}s; each saved/rendered immediately with the same button')

            page.locator('.sync-strip button').click()
            page.locator('#enableSyncButton').click()
            page.locator('#signInButton').click()
            page.wait_for_function('syncStore.meta.pending.length === 0 && syncTest.remote !== null')
            page.locator('.panel-close').click()
            page.wait_for_function('document.getElementById("settingsPanel").getBoundingClientRect().left >= window.innerWidth')
            x, y = position(plus)
            page.evaluate(f"window.originalButton = document.querySelector('[data-habit-id=\"{HABIT}\"] .inc'); syncTest.deferWrites = true")
            tap(21, x, y)
            page.evaluate('void cloudController.syncNow()')
            page.wait_for_function('syncTest.releases.length > 0')
            for count in range(22, 41):
                if count == 30:
                    page.evaluate('syncTest.release()')
                tap(count, x, y)
            page.wait_for_function('syncStore.meta.pending.length === 0')
            assert page.evaluate(f"syncTest.remote.state.data['{DAY}'].{HABIT}") == 40
            assert page.evaluate('originalButton.isConnected'), 'An acknowledgement rebuilt the controls'
            print(f'{engine}: racing upload acknowledgements preserve rapid taps and never replace the button')

            # Firestore orders map keys differently from localStorage JSON.
            # A semantically identical echo must not repaint cards OR summary.
            page.evaluate("""
              window.originalSummary = document.querySelector('#summaryContent').firstElementChild;
              function reorderKeys(value) {
                if (Array.isArray(value)) return value.map(reorderKeys);
                if (value && typeof value === 'object') return Object.fromEntries(
                  Object.keys(value).reverse().map(key => [key, reorderKeys(value[key])])
                );
                return value;
              }
              syncTest.emit(reorderKeys(syncTest.remote));
            """)
            assert page.evaluate('originalButton.isConnected && originalSummary.isConnected')

            # Even long error messages cannot move the next tap's target.
            before = plus.bounding_box()
            page.evaluate("renderSyncStatus({...cloudStatus, message:'Saved on device · waiting for a very slow connection. Your changes are safe and will sync later.'})")
            assert plus.bounding_box() == before

            # Incoming counter changes patch existing controls after the burst.
            page.evaluate(f"""
              const changed = structuredClone(syncTest.remote);
              changed.revision++;
              changed.state.data['{DAY}'].h_0 = 7;
              syncTest.emit(changed);
            """)
            page.wait_for_function(f"document.querySelector('[data-habit-id=\"h_0\"] .counter-value').textContent === '7'")
            assert page.evaluate('originalButton.isConnected')

            # Hold a finger down longer than the idle interval while another
            # device reorders the list. Reordering must wait until AFTER release
            # and the next burst, not cancel the upcoming click.
            plus.dispatch_event('pointerdown', {'pointerId': 77, 'pointerType': 'touch', 'bubbles': True})
            page.evaluate("""
              const reordered = structuredClone(syncTest.remote);
              reordered.revision++;
              reordered.state.habits.reverse();
              syncTest.emit(reordered);
            """)
            page.evaluate('() => new Promise(resolve => setTimeout(resolve, 700))')
            assert page.evaluate('originalButton.isConnected'), 'Remote reorder interrupted a held press'
            plus.dispatch_event('pointerup', {'pointerId': 77, 'pointerType': 'touch', 'bubbles': True})
            tap(41, x, y)
            page.wait_for_function(f"state.habits[0].id === '{HABIT}' && syncStore.meta.pending.length === 0")
            assert page.evaluate(f"syncTest.remote.state.data['{DAY}'].{HABIT}") == 41

            # Stable decrement targets and zero clamping work without network.
            page.evaluate('disconnectCloudSync()')
            x, y = position(minus)
            page.evaluate(f"window.originalButton = document.querySelector('[data-habit-id=\"{HABIT}\"] .inc')")
            for count in range(40, -1, -1):
                tap(count, x, y)
            tap(0, x, y)
            assert page.locator(f'[data-habit-id="{HABIT}"] .counter-value').get_attribute('class') == 'counter-value zero'
            assert page.evaluate('syncStore.meta.pending.length') == 41
            assert len(navigations) == 1, 'A tap navigated/reloaded the page'
            assert not errors, errors
            print(f'{engine}: deferred remote reorder, counter-only remote patch, rapid decrement/zero clamp, offline outbox and no page reload PASS')
            browser.close()
finally:
    server.shutdown()
