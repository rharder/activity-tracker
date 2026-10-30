import { firebaseConfig, trackerCollection } from './firebase-config.js';

const snapshotExists = snapshot => typeof snapshot.exists === 'function' ? snapshot.exists() : snapshot.exists;

function loadScript(name, ready) {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://www.gstatic.com/firebasejs/12.18.0/firebase-${name}-compat.js`;
    script.async = true;
    script.onload = () => ready() ? resolve() : reject(new Error('Firebase SDK unavailable'));
    script.onerror = () => { script.remove(); reject(new Error('Firebase SDK download failed')); };
    document.head.appendChild(script);
  });
}

async function loadFirebase() {
  // Classic scripts can retry a failed download without reloading the app.
  // Failed dynamic ES-module imports are cached by some browsers until reload.
  await loadScript('app', () => !!window.firebase?.initializeApp);
  await Promise.all([
    loadScript('auth', () => !!window.firebase?.auth),
    loadScript('firestore', () => !!window.firebase?.firestore)
  ]);
  const firebase = window.firebase;
  return {
    initializeApp: (config, name) => firebase.apps.find(app => app.name === name) || firebase.initializeApp(config, name),
    getAuth: app => app.auth(),
    getFirestore: app => app.firestore(),
    browserLocalPersistence: firebase.auth.Auth.Persistence.LOCAL,
    setPersistence: (auth, persistence) => auth.setPersistence(persistence),
    GoogleAuthProvider: firebase.auth.GoogleAuthProvider,
    onAuthStateChanged: (auth, callback) => auth.onAuthStateChanged(callback),
    signInWithPopup: (auth, provider) => auth.signInWithPopup(provider),
    signOut: auth => auth.signOut(),
    doc: (db, collection, uid) => db.collection(collection).doc(uid),
    onSnapshot: (ref, options, next, error) => ref.onSnapshot(options, next, error),
    getDocFromServer: ref => ref.get({ source: 'server' }),
    runTransaction: (db, update, options) => db.runTransaction(update, options)
  };
}

// Firebase is optional: this module is loaded only after opting in. The host has
// already rendered local data, and every edit is durably saved before notifying us.
export async function createCloudSync(host, sdkLoader = loadFirebase) {
  const sdk = await sdkLoader();
  const app = sdk.initializeApp(firebaseConfig, 'activity-tracker');
  const auth = sdk.getAuth(app);
  const db = sdk.getFirestore(app);
  await sdk.setPersistence(auth, sdk.browserLocalPersistence).catch(() => {});
  const provider = new sdk.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  let user = null;
  let unsubscribe = null;
  let generation = 0;
  let timer = null;
  let inFlight = false;
  let latestRemote = null;
  let failures = 0;

  const active = () => host.store.meta.enabled && user && host.store.meta.uid === user.uid;
  const report = (kind, message) => host.onStatus({ kind, message, ready: true, user });

  function schedule(delay = 350) {
    clearTimeout(timer);
    if (active()) timer = setTimeout(syncNow, delay);
  }

  function applyRemote() {
    if (!latestRemote || !active() || !host.canApplyRemote()) return;
    const next = host.store.reconcile(latestRemote);
    if (next) host.onState(next);
    latestRemote = null;
  }

  function receive(document) {
    if (!active()) return;
    if (document) {
      ActivitySyncState.applyPending(document, [], user.uid); // Validate first.
      if (!latestRemote || document.revision >= latestRemote.revision) latestRemote = document;
      applyRemote();
    }
    failures = 0;
    const outstanding = host.store.meta.pending.some(entry =>
      entry.sequence > (document?.applied[entry.actor] || 0));
    if (outstanding) {
      report('pending', 'Saved on device · sync pending');
      schedule();
    } else report('synced', 'Synced with Google');
  }

  function failed(error) {
    const denied = error.code === 'permission-denied' || error.code === 'unauthenticated';
    const invalid = error.code === 'invalid-argument' || error.message?.includes('unsupported format');
    report(denied || invalid ? 'error' : 'pending', denied
      ? 'Cloud access unavailable. Your changes are safe on this device.'
      : invalid ? 'Cloud data could not be synced. Keep a JSON backup; your local tracker is safe.'
      : 'Saved on device · waiting for a connection');
    if (!denied && !invalid) schedule(Math.min(60000, 2000 * 2 ** Math.min(failures++, 5)));
  }

  async function syncNow() {
    applyRemote();
    if (!active() || inFlight) return;
    if (!navigator.onLine) {
      report('pending', 'Offline · saved on device');
      schedule(30000);
      return;
    }
    const token = generation;
    const uid = user.uid;
    const ref = sdk.doc(db, trackerCollection, uid);
    const saved = host.store.snapshot()._sync;
    if (!saved?.enabled || saved.uid !== uid) return;
    const pending = structuredClone(saved.pending.filter(entry =>
      entry.sequence > (latestRemote?.applied[entry.actor] || 0)));
    if (!pending.length && latestRemote) return report('synced', 'Synced · finish editing to show incoming changes');
    inFlight = true;
    report('pending', 'Saved on device · syncing…');
    const slow = setTimeout(() => {
      if (token === generation && active()) report('pending', 'Saved on device · waiting for sync to finish');
    }, 8000);
    try {
      if (pending.length) {
        const document = await sdk.runTransaction(db, async transaction => {
          const snapshot = await transaction.get(ref);
          const result = ActivitySyncState.applyPending(snapshotExists(snapshot) ? snapshot.data() : null, pending, uid);
          if (result.changed) transaction.set(ref, result.document);
          return result.document;
        }, { maxAttempts: 3 });
        if (token === generation && active()) receive(document);
      } else {
        const snapshot = await sdk.getDocFromServer(ref);
        if (token === generation && active()) {
          if (snapshotExists(snapshot)) receive(snapshot.data());
          else report('error', 'Cloud tracker unavailable. Your local copy has not been replaced.');
        }
      }
    } catch (error) {
      if (token === generation && active()) failed(error);
    } finally {
      clearTimeout(slow);
      if (token === generation) inFlight = false;
    }
  }

  function watch() {
    unsubscribe?.();
    const token = generation;
    const ref = sdk.doc(db, trackerCollection, user.uid);
    unsubscribe = sdk.onSnapshot(ref, { includeMetadataChanges: true }, snapshot => {
      if (token !== generation || !active()) return;
      // A cached or locally speculative snapshot is NOT an acknowledgement.
      if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
      try {
        if (snapshotExists(snapshot)) receive(snapshot.data());
        else schedule(0);
      } catch (error) { failed(error); }
    }, error => {
      if (token === generation && active()) failed(error);
    });
    schedule(0);
  }

  function connectUser(nextUser) {
    generation++;
    unsubscribe?.();
    unsubscribe = null;
    clearTimeout(timer);
    inFlight = false;
    latestRemote = null;
    user = nextUser;
    if (!host.store.meta.enabled) return report('local', 'Local only · saved on this device');
    if (!user) return report('signedOut', 'Sign in to sync. Local tracking works without an account.');
    if (host.store.meta.uid && host.store.meta.uid !== user.uid) {
      return report('mismatch', `This device is linked to ${host.store.meta.email || 'another Google account'}. Switch trackers or sign in with that account.`);
    }
    try {
      host.store.bind(user);
    } catch (error) {
      return report('error', 'Could not connect this account. Your saved tracker is intact; check device storage and retry.');
    }
    report('pending', 'Saved on device · connecting to Google…');
    watch();
  }

  const unsubscribeAuth = sdk.onAuthStateChanged(auth, connectUser);

  function changed() {
    if (!active()) return;
    report('pending', navigator.onLine ? 'Saved on device · sync pending' : 'Offline · saved on device');
    schedule();
  }

  function foreground() {
    applyRemote();
    if (active()) schedule(0); // Reverify after returning to a potentially stale screen.
  }

  const onVisibility = () => { if (document.visibilityState === 'visible') foreground(); };
  const onOffline = () => { if (active()) report('pending', 'Offline · saved on device'); };
  const onBlur = () => setTimeout(() => {
    applyRemote();
    if (active() && host.store.meta.pending.length) schedule();
  }, 0);
  window.addEventListener('online', foreground);
  window.addEventListener('offline', onOffline);
  window.addEventListener('pageshow', foreground);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('focusout', onBlur);
  document.addEventListener('pointerup', onBlur);
  document.addEventListener('touchend', onBlur, { passive: true });

  return {
    changed,
    syncNow,
    // Called directly by the button handler, preserving the popup user gesture.
    signIn() {
      sdk.signInWithPopup(auth, provider).catch(error => {
        if (error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') {
          return report('signedOut', 'Sign-in cancelled. Your local tracker is unchanged.');
        }
        report('error', error.code === 'auth/popup-blocked'
          ? 'Google sign-in was blocked. Allow pop-ups and try Continue with Google again.'
          : 'Google sign-in could not finish. Local tracking is still available.');
      });
    },
    switchAccount() {
      if (!user || !confirm('Switch trackers? The current tracker and unsynced edits will be saved separately on this device, not uploaded to the other account.')) return;
      try {
        host.onState(host.store.switchAccount(user));
        connectUser(user);
      } catch (error) {
        report('mismatch', 'Could not switch trackers. The saved tracker is intact; check device storage and try again.');
      }
    },
    disconnect() {
      host.store.setEnabled(false);
      generation++;
      unsubscribe?.();
      unsubscribe = null;
      clearTimeout(timer);
      latestRemote = null;
      report('local', 'Sync off · edits stay on this device until you reconnect');
      sdk.signOut(auth).catch(() => {});
    },
    destroy() {
      generation++;
      unsubscribeAuth();
      unsubscribe?.();
      clearTimeout(timer);
      window.removeEventListener('online', foreground);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('pageshow', foreground);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('focusout', onBlur);
      document.removeEventListener('pointerup', onBlur);
      document.removeEventListener('touchend', onBlur);
    }
  };
}
