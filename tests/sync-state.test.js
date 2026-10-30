const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../site/sync-state.js');
const { Store, applyPending, emptyState } = globalThis.ActivitySyncState;
const key = 'habit_tracker_v1';
const user = { uid: 'alice', email: 'alice@example.com' };
const day = '2026-10-30';
const fixture = () => ({ ...emptyState(), habits: [{ id: 'h_one', name: 'Walk', color: '#e8834a', created: day }], data: { [day]: { h_one: 3 } } });

function storage(initial) {
  const values = new Map(initial ? [[key, JSON.stringify(initial)]] : []);
  return {
    getItem: name => values.get(name) || null,
    setItem: (name, value) => values.set(name, value)
  };
}

function device(initial = fixture()) {
  const memory = storage(initial);
  const store = new Store(memory, key);
  store.bind(user);
  return store;
}

function upload(store, remote = null) {
  const result = applyPending(remote, store.snapshot()._sync.pending, user.uid);
  store.reconcile(result.document);
  return result.document;
}

function increment(store, amount = 1) {
  const next = structuredClone(store.state);
  next.data[day].h_one += amount;
  store.save(next);
}

test('legacy data loads immediately without migrating or requiring an account', () => {
  const memory = storage(fixture());
  const original = memory.getItem(key);
  const store = new Store(memory, key);
  assert.deepEqual(store.state, fixture());
  assert.equal(memory.getItem(key), original);
  assert.equal(store.meta.enabled, false);
  increment(store);
  assert.equal(store.state.data[day].h_one, 4);
  assert.equal(store.meta.pending.length, 0);
  assert.equal('_sync' in store.state, false);
});

test('the state and account-bound outbox are saved atomically', () => {
  const store = device();
  increment(store);
  const saved = store.snapshot();
  assert.equal(saved.data[day].h_one, 4);
  assert.equal(saved._sync.uid, user.uid);
  assert.equal(saved._sync.pending.length, 2);
  assert.deepEqual(saved._sync.pending[1].changes, [{ type: 'count', day, id: 'h_one', delta: 1 }]);
});

test('initial copies of the same backup merge without doubling counts', () => {
  const a = device();
  const b = device();
  const remote = upload(b, upload(a));
  assert.equal(remote.state.data[day].h_one, 3);
  assert.equal(remote.state.habits.length, 1);
});

test('offline increments on two devices are both preserved', () => {
  const a = device();
  const b = device();
  let remote = upload(b, upload(a));
  a.reconcile(remote);
  increment(a, 2);
  increment(b, 3);
  remote = upload(b, upload(a, remote));
  a.reconcile(remote);
  assert.equal(remote.state.data[day].h_one, 8);
  assert.deepEqual(a.state, b.state);
});

test('a retried acknowledged transaction never applies counts twice', () => {
  const store = device();
  let remote = upload(store);
  increment(store);
  const pending = structuredClone(store.meta.pending);
  remote = applyPending(remote, pending, user.uid).document;
  const retry = applyPending(remote, pending, user.uid);
  assert.equal(retry.changed, false);
  assert.equal(retry.document.state.data[day].h_one, 4);
  assert.equal(retry.document.revision, remote.revision);
});

test('edits made during a slow upload survive its delayed acknowledgement', () => {
  const store = device();
  let remote = upload(store);
  increment(store);
  const inFlight = structuredClone(store.meta.pending);
  increment(store);
  remote = applyPending(remote, inFlight, user.uid).document;
  store.reconcile(remote);
  assert.equal(store.state.data[day].h_one, 5);
  assert.equal(store.meta.pending.length, 1);
  remote = upload(store, remote);
  assert.equal(remote.state.data[day].h_one, 5);
});

test('the outbox survives a reload or app update before upload', () => {
  let store = device();
  let remote = upload(store);
  increment(store, 2);
  const previousActor = store.actor;
  store = new Store(store.storage, key);
  assert.notEqual(store.actor, previousActor);
  assert.equal(store.meta.pending.length, 1);
  increment(store);
  remote = upload(store, remote);
  assert.equal(remote.state.data[day].h_one, 6);
});

test('deletion does not get undone by stale offline counts or renames', () => {
  const a = device();
  const b = device();
  let remote = upload(b, upload(a));
  a.reconcile(remote);
  const next = structuredClone(a.state);
  next.habits = [];
  next.data = {};
  a.save(next);
  increment(b);
  const renamed = structuredClone(b.state);
  renamed.habits[0].name = 'Stale name';
  b.save(renamed);
  remote = upload(b, upload(a, remote));
  assert.deepEqual(remote.state.habits, []);
  assert.deepEqual(remote.state.data, {});
});

test('renames, settings, new activities and counts merge at field level', () => {
  const a = device();
  const b = device();
  let remote = upload(b, upload(a));
  a.reconcile(remote);
  const first = structuredClone(a.state);
  first.habits[0].name = 'Walking';
  first.theme = 'light';
  a.save(first);
  const second = structuredClone(b.state);
  second.weekStart = 1;
  second.habits.push({ id: 'h_two', name: 'Read', color: '#fff', created: day });
  b.save(second);
  increment(b);
  remote = upload(b, upload(a, remote));
  assert.equal(remote.state.habits[0].name, 'Walking');
  assert.equal(remote.state.habits.length, 2);
  assert.equal(remote.state.data[day].h_one, 4);
  assert.equal(remote.state.theme, 'light');
  assert.equal(remote.state.weekStart, 1);
});

test('explicit resets replace synced data and survive retries', () => {
  const store = device();
  let remote = upload(store);
  store.save(emptyState(), { replace: true });
  remote = upload(store, remote);
  assert.deepEqual(remote.state, emptyState());
});

test('turning sync off keeps queuing edits for the original account', () => {
  const store = device();
  let remote = upload(store);
  store.setEnabled(false);
  increment(store);
  assert.equal(store.meta.enabled, false);
  assert.equal(store.meta.pending.length, 1);
  store.bind(user);
  remote = upload(store, remote);
  assert.equal(remote.state.data[day].h_one, 4);
});

test('another Google account cannot silently upload the previous account data', () => {
  const store = device();
  increment(store);
  const original = structuredClone(store.state);
  const other = { uid: 'bob', email: 'bob@example.com' };
  assert.throws(() => store.bind(other), /account-mismatch/);
  assert.deepEqual(store.switchAccount(other), emptyState());
  assert.deepEqual(store.switchAccount(user), original);
  assert.equal(store.meta.pending.length, 2);
});

test('late and malformed cloud snapshots do not replace local data', () => {
  const store = device();
  const old = upload(store);
  increment(store);
  const current = upload(store, old);
  assert.equal(store.reconcile(old), null);
  assert.equal(store.state.data[day].h_one, 4);
  assert.throws(() => store.reconcile({ ...current, schemaVersion: 99 }), /unsupported/);
  assert.equal(store.snapshot().data[day].h_one, 4);
});

test('two tabs have distinct actors and read the latest shared outbox', () => {
  const a = device();
  const remote = upload(a);
  const b = new Store(a.storage, key);
  increment(a);
  increment(b);
  assert.notEqual(a.actor, b.actor);
  const result = upload(b, remote);
  assert.equal(result.state.data[day].h_one, 5);
});

test('imported sync metadata cannot rebind an account or appear in exported state', () => {
  const store = device();
  store.save({ ...fixture(), _sync: { uid: 'attacker' } }, { replace: true });
  assert.equal(store.meta.uid, user.uid);
  assert.equal('_sync' in store.state, false);
});

test('a full localStorage never pretends an edit or outbox was saved', () => {
  const store = device();
  const saved = store.snapshot();
  store.storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => increment(store), /QuotaExceeded/);
  assert.deepEqual(store.snapshot(), saved);
  assert.deepEqual(store.state, fixture());
});

test('edits during first sign-in are separate from the initial merge baseline', () => {
  const existing = device();
  increment(existing, 7);
  const remote = upload(existing);
  const joining = new Store(storage(fixture()), key);
  joining.setEnabled(true);
  increment(joining); // Google/SDK is still loading; local count goes from 3 to 4.
  joining.bind(user);
  const result = upload(joining, remote);
  assert.equal(result.state.data[day].h_one, 11); // max(10, baseline 3) + new edit 1
});

test('cancelling a never-linked sign-in keeps local edits without a stray queue', () => {
  const store = new Store(storage(fixture()), key);
  store.setEnabled(true);
  increment(store);
  store.setEnabled(false);
  assert.equal(store.state.data[day].h_one, 4);
  assert.equal(store.meta.pending.length, 0);
  assert.equal(store.meta.uid, null);
});

test('a failed account switch leaves the complete previous tracker active', () => {
  const store = device();
  const original = store.snapshot();
  const save = store.storage.setItem;
  store.storage.setItem = (name, value) => {
    if (name === key) throw new Error('QuotaExceededError');
    save(name, value);
  };
  assert.throws(() => store.switchAccount({uid:'bob', email:'bob@example.com'}), /QuotaExceeded/);
  assert.deepEqual(store.snapshot(), original);
  assert.equal(store.meta.uid, user.uid);
});
