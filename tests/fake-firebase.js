// Deterministic network/auth double for browser tests. Never used by the app.
(() => {
  let authListener = null;
  const listeners = new Set();
  const snapshot = (data, fromCache = false) => ({
    exists: !!data,
    data: () => structuredClone(data),
    metadata: { fromCache, hasPendingWrites: false }
  });
  const test = window.syncTest = {
    user: null,
    remote: null,
    uploads: 0,
    deferWrites: false,
    releases: [],
    error: null,
    emit(data, cached = false) {
      this.remote = structuredClone(data);
      for (const listener of listeners) listener(snapshot(data, cached));
    },
    release() {
      this.deferWrites = false;
      this.releases.splice(0).forEach(resolve => resolve());
    },
    changeUser(user) {
      this.user = user;
      authListener?.(user);
    }
  };
  window.fakeFirebase = {
    initializeApp: () => ({}),
    getAuth: () => ({}),
    getFirestore: () => ({}),
    browserLocalPersistence: {},
    setPersistence: async () => {},
    GoogleAuthProvider: class { setCustomParameters() {} },
    onAuthStateChanged(auth, callback) {
      authListener = callback;
      queueMicrotask(() => callback(test.user));
      return () => { authListener = null; };
    },
    signInWithPopup: async () => test.changeUser({ uid: 'alice', email: 'alice@example.com' }),
    signOut: async () => test.changeUser(null),
    doc: (db, collection, uid) => ({ collection, uid }),
    onSnapshot(ref, options, callback) {
      listeners.add(callback);
      queueMicrotask(() => callback(snapshot(test.remote, true)));
      return () => listeners.delete(callback);
    },
    getDocFromServer: async () => {
      if (!navigator.onLine) throw { code: 'unavailable' };
      return snapshot(test.remote);
    },
    async runTransaction(db, update) {
      test.uploads++;
      if (test.deferWrites) await new Promise(resolve => test.releases.push(resolve));
      if (test.error) throw { code: test.error };
      if (!navigator.onLine) throw { code: 'unavailable' };
      let write = null;
      const result = await update({
        get: async () => snapshot(test.remote),
        set: (ref, document) => { write = document; }
      });
      if (write) test.emit(write);
      return result;
    }
  };
})();
