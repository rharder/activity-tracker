// Optional integration check. Requires a separately installed Firebase JS SDK
// (FIREBASE_SDK_PATH), and FIRESTORE_EMULATOR_HOST. Never targets production.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Refusing to run without FIRESTORE_EMULATOR_HOST');
const sdkPath = process.env.FIREBASE_SDK_PATH || 'firebase';
const { initializeApp, deleteApp } = require(path.join(sdkPath, 'app'));
const { getFirestore, connectFirestoreEmulator, doc, collection, getDocFromServer, getDocs, setDoc, runTransaction } = require(path.join(sdkPath, 'firestore'));
require('../site/sync-state.js');
const { Store, applyPending, emptyState } = ActivitySyncState;
const apps = [];
const projectId = 'demo-activity-tracker';
const day = '2026-10-30';
const fixture = () => ({ ...emptyState(), habits: [{ id: 'h_one', name: 'Walk', color: '#e8834a', created: day }], data: { [day]: { h_one: 3 } } });

function client(uid) {
  const app = initializeApp({ projectId, apiKey: 'demo-api-key', appId: 'demo-app' }, `test-${uid}-${apps.length}`);
  apps.push(app);
  const db = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  const options = uid === 'admin' ? { mockUserToken: 'owner' } : uid ? {
    mockUserToken: { sub: uid, user_id: uid, email: `${uid}@example.com`, firebase: { sign_in_provider: 'google.com' } }
  } : {};
  connectFirestoreEmulator(db, host, Number(port), options);
  return db;
}

function device() {
  const values = new Map([['tracker', JSON.stringify(fixture())]]);
  const store = new Store({ getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) }, 'tracker');
  store.bind({ uid: 'alice', email: 'alice@example.com' });
  return store;
}

function increment(store, delta) {
  const next = structuredClone(store.state);
  next.data[day].h_one += delta;
  store.save(next);
}

async function upload(db, store, pending = store.meta.pending) {
  const ref = doc(db, 'activityTrackers', 'alice');
  const result = await runTransaction(db, async tx => {
    const snapshot = await tx.get(ref);
    const update = applyPending(snapshot.exists() ? snapshot.data() : null, pending, 'alice');
    if (update.changed) tx.set(ref, update.document);
    return update.document;
  });
  store.reconcile(result);
  return result;
}

after(async () => Promise.all(apps.map(deleteApp)));

test('real Firestore transactions merge concurrent devices and enforce private rules', async () => {
  const alice = client('alice');
  const secondAlice = client('alice');
  const bob = client('bob');
  const anonymous = client(null);
  const a = device();
  const b = device();
  await upload(alice, a);
  let remote = await upload(secondAlice, b);
  a.reconcile(remote);
  increment(a, 2);
  increment(b, 3);
  await Promise.all([upload(alice, a), upload(secondAlice, b)]);
  remote = (await getDocFromServer(doc(alice, 'activityTrackers', 'alice'))).data();
  assert.equal(remote.state.data[day].h_one, 8);
  a.reconcile(remote);
  increment(a, 1);
  const pending = structuredClone(a.meta.pending);
  await upload(alice, a, pending);
  remote = await upload(alice, a, pending);
  assert.equal(remote.state.data[day].h_one, 9);
  const denied = promise => assert.rejects(promise, error => error.code === 'permission-denied');
  await denied(getDocFromServer(doc(bob, 'activityTrackers', 'alice')));
  await denied(getDocFromServer(doc(anonymous, 'activityTrackers', 'alice')));
  await denied(getDocs(collection(alice, 'activityTrackers')));
  await denied(setDoc(doc(bob, 'activityTrackers', 'alice'), { ...remote, revision: remote.revision + 1 }));
  await denied(setDoc(doc(alice, 'activityTrackers', 'alice'), { ...remote, ownerUid: 'bob', revision: remote.revision + 1 }));
  await denied(setDoc(doc(alice, 'activityTrackers', 'alice'), { ...remote, revision: 0 }));
  await denied(setDoc(doc(alice, 'activityTrackers', 'alice'), { ...remote, revision: remote.revision + 1, state: { ...remote.state, weekStart: 99 } }));
});

test('shared money and permit rules retain their existing owner/viewer protections', async () => {
  const admin = client('admin');
  const parent = client('parent');
  const viewer = client('viewer');
  const outsider = client('outsider');
  const family = { ownerUid: 'parent', ownerEmail: 'parent@example.com', schemaVersion: 3, kids: [], transactions: [], memberEmails: ['viewer@example.com'] };
  await setDoc(doc(admin, 'families', 'test-family'), family);
  assert.equal((await getDocFromServer(doc(viewer, 'families', 'test-family'))).exists(), true);
  await setDoc(doc(parent, 'families', 'test-family'), { ...family, kids: [{ id: 'fake-child' }] });
  await assert.rejects(setDoc(doc(viewer, 'families', 'test-family'), family), error => error.code === 'permission-denied');
  await assert.rejects(getDocFromServer(doc(outsider, 'families', 'test-family')), error => error.code === 'permission-denied');
  const permit = { schemaVersion: 1, ownerUid: 'parent', ownerEmail: 'parent@example.com', supervisorEmails: [], viewerEmails: ['viewer@example.com'], payload: { version: 1, drivers: [], sessions: [] } };
  await setDoc(doc(admin, 'permitHourFamilies', 'parent'), permit);
  for (const [email, role] of [['parent@example.com', 'owner'], ['viewer@example.com', 'viewer']]) {
    await setDoc(doc(admin, 'permitHourAccess', email), { email, role, familyId: 'parent' });
  }
  assert.equal((await getDocFromServer(doc(viewer, 'permitHourFamilies', 'parent'))).exists(), true);
  await setDoc(doc(parent, 'permitHourFamilies', 'parent'), permit);
  await assert.rejects(setDoc(doc(viewer, 'permitHourFamilies', 'parent'), permit), error => error.code === 'permission-denied');
  await assert.rejects(getDocFromServer(doc(outsider, 'permitHourFamilies', 'parent')), error => error.code === 'permission-denied');
});
