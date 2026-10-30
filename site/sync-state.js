// Local-first state and durable outbox. No Firebase or network dependency.
(() => {
  const clone = value => JSON.parse(JSON.stringify(value));
  const emptyState = () => ({ habits: [], data: {}, weekStart: 0, theme: 'dark' });
  const validState = value => value && Array.isArray(value.habits) &&
    value.data && typeof value.data === 'object' && !Array.isArray(value.data);
  const userState = value => {
    const { _sync, ...data } = value || {};
    return { ...emptyState(), ...data };
  };
  const uniqueId = () => crypto.randomUUID();

  function changesBetween(before, after) {
    const changes = [];
    const oldHabits = new Map(before.habits.map(habit => [habit.id, habit]));
    const newHabits = new Map(after.habits.map(habit => [habit.id, habit]));
    for (const [id] of oldHabits) {
      if (!newHabits.has(id)) changes.push({ type: 'deleteHabit', id });
    }
    for (const [id, habit] of newHabits) {
      const previous = oldHabits.get(id);
      if (!previous) changes.push({ type: 'addHabit', habit: clone(habit) });
      else {
        const fields = {};
        for (const key of ['name', 'color', 'created']) {
          if (previous[key] !== habit[key]) fields[key] = habit[key];
        }
        if (Object.keys(fields).length) changes.push({ type: 'editHabit', id, fields });
      }
    }
    const order = after.habits.map(habit => habit.id);
    if (JSON.stringify(order) !== JSON.stringify(before.habits.map(habit => habit.id))) {
      changes.push({ type: 'order', ids: order });
    }
    for (const day of new Set([...Object.keys(before.data), ...Object.keys(after.data)])) {
      const oldDay = before.data[day] || {};
      const newDay = after.data[day] || {};
      for (const id of new Set([...Object.keys(oldDay), ...Object.keys(newDay)])) {
        // Deleting an activity already deletes all its counts, including remote ones.
        if (!newHabits.has(id)) continue;
        const delta = (newDay[id] || 0) - (oldDay[id] || 0);
        if (delta) changes.push({ type: 'count', day, id, delta });
      }
    }
    for (const key of ['theme', 'weekStart']) {
      if (before[key] !== after[key]) changes.push({ type: 'setting', key, value: after[key] });
    }
    return changes;
  }

  function mergeInitial(remote, local) {
    const merged = clone(remote);
    const existing = new Set(merged.habits.map(habit => habit.id));
    for (const habit of local.habits) {
      if (!existing.has(habit.id)) merged.habits.push(clone(habit));
    }
    for (const [day, counts] of Object.entries(local.data)) {
      for (const [id, count] of Object.entries(counts)) {
        if (!merged.data[day]) merged.data[day] = {};
        // Two devices may start with the same backup: don't count it twice.
        merged.data[day][id] = Math.max(merged.data[day][id] || 0, count);
      }
    }
    if (!remote.habits.length && !Object.keys(remote.data).length) {
      merged.theme = local.theme;
      merged.weekStart = local.weekStart;
    }
    return merged;
  }

  function applyChanges(initial, changes) {
    let state = clone(initial);
    for (const change of changes) {
      if (change.type === 'replace') state = clone(change.state);
      else if (change.type === 'merge') state = mergeInitial(state, change.state);
      else if (change.type === 'addHabit') {
        if (!state.habits.some(habit => habit.id === change.habit.id)) state.habits.push(clone(change.habit));
      } else if (change.type === 'editHabit') {
        const habit = state.habits.find(item => item.id === change.id);
        if (habit) Object.assign(habit, change.fields);
      } else if (change.type === 'deleteHabit') {
        state.habits = state.habits.filter(habit => habit.id !== change.id);
        for (const day of Object.keys(state.data)) {
          delete state.data[day][change.id];
          if (!Object.keys(state.data[day]).length) delete state.data[day];
        }
      } else if (change.type === 'order') {
        const ranks = new Map(change.ids.map((id, index) => [id, index]));
        state.habits.sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
      } else if (change.type === 'count') {
        // A stale offline increment must not resurrect a deleted activity.
        if (!state.habits.some(habit => habit.id === change.id)) continue;
        if (!state.data[change.day]) state.data[change.day] = {};
        const value = Math.max(0, (state.data[change.day][change.id] || 0) + change.delta);
        if (value) state.data[change.day][change.id] = value;
        else delete state.data[change.day][change.id];
        if (!Object.keys(state.data[change.day]).length) delete state.data[change.day];
      } else if (change.type === 'setting') state[change.key] = change.value;
    }
    return state;
  }

  function applyPending(document, pending, uid) {
    if (document && (document.schemaVersion !== 1 || document.ownerUid !== uid ||
        !validState(document.state) || !Number.isInteger(document.revision) ||
        !document.applied || typeof document.applied !== 'object')) {
      throw new Error('The cloud tracker has an unsupported format. Local data is safe.');
    }
    const result = document ? clone(document) : {
      schemaVersion: 1, ownerUid: uid, revision: 0, state: emptyState(), applied: {}
    };
    let changed = !document;
    for (const entry of pending) {
      if (entry.sequence <= (result.applied[entry.actor] || 0)) continue;
      result.state = applyChanges(result.state, entry.changes);
      result.applied[entry.actor] = entry.sequence;
      changed = true;
    }
    if (changed) result.revision++;
    return { document: result, changed };
  }

  class Store {
    constructor(storage, key) {
      this.storage = storage;
      this.key = key;
      // Distinct actors prevent two open tabs from reusing an operation number.
      this.actor = uniqueId();
      this.sequence = 0;
      this.read();
    }

    read() {
      let saved = null;
      try { saved = JSON.parse(this.storage.getItem(this.key)); } catch {}
      if (saved && !validState(saved)) throw new Error('Saved tracker data is invalid; it has not been replaced.');
      this.state = userState(saved);
      this.meta = saved?._sync || { version: 1, uid: null, email: null, enabled: false, pending: [], revision: 0 };
      if (this.meta.version !== 1 || !Array.isArray(this.meta.pending)) throw new Error('Unsupported local sync format.');
    }

    persist() {
      // One atomic localStorage write saves BOTH the display state and its outbox.
      try {
        this.storage.setItem(this.key, JSON.stringify({ ...this.state, _sync: this.meta }));
      } catch (error) {
        this.read();
        throw error;
      }
    }

    snapshot() {
      return JSON.parse(this.storage.getItem(this.key)) || { ...emptyState(), _sync: this.meta };
    }

    append(changes) {
      if (changes.length) this.meta.pending.push({ actor: this.actor, sequence: ++this.sequence, changes });
    }

    save(next, { replace = false } = {}) {
      next = userState(next);
      const changes = replace ? [{ type: 'replace', state: clone(next) }] : changesBetween(this.state, next);
      const previousUid = this.meta.uid;
      this.read(); // Include changes just saved by another tab before adding ours.
      if (previousUid && this.meta.uid !== previousUid) throw new Error('The active account changed in another tab. Reopen this tracker before editing.');
      this.state = applyChanges(this.state, changes);
      if (this.meta.uid || this.meta.enabled) this.append(changes);
      this.persist();
      return clone(this.state);
    }

    bind(user) {
      this.read();
      if (this.meta.uid && this.meta.uid !== user.uid) throw new Error('account-mismatch');
      if (!this.meta.uid) {
        this.meta.uid = user.uid;
        if (!this.meta.pending.length) this.append([{ type: 'merge', state: clone(this.state) }]);
      }
      this.meta.email = user.email;
      this.meta.enabled = true;
      this.persist();
    }

    switchAccount(user) {
      this.read();
      if (this.meta.uid) this.storage.setItem(`${this.key}:account:${this.meta.uid}`, JSON.stringify({ ...this.state, _sync: this.meta }));
      const raw = this.storage.getItem(`${this.key}:account:${user.uid}`);
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && (!validState(saved) || saved._sync?.uid !== user.uid)) throw new Error('Invalid archived account');
      this.state = userState(saved);
      this.meta = saved?._sync || { version: 1, uid: user.uid, email: user.email, enabled: true, pending: [], revision: 0 };
      this.meta.enabled = true;
      if (!saved) this.append([{ type: 'merge', state: clone(this.state) }]);
      // Replace the active account in one write, after safely archiving the old
      // one. A quota failure must not leave an empty half-switched tracker.
      this.persist();
      return clone(this.state);
    }

    setEnabled(enabled) {
      this.read();
      this.meta.enabled = enabled;
      if (!this.meta.uid) {
        if (!enabled) this.meta.pending = [];
        else if (!this.meta.pending.length) this.append([{ type: 'merge', state: clone(this.state) }]);
      }
      this.persist();
    }

    reconcile(document) {
      this.read();
      if (document.ownerUid !== this.meta.uid || document.revision < this.meta.revision) return null;
      applyPending(document, [], this.meta.uid); // Validate before touching local data.
      this.meta.pending = this.meta.pending.filter(entry => entry.sequence > (document.applied[entry.actor] || 0));
      this.meta.revision = document.revision;
      this.state = this.meta.pending.reduce((state, entry) => applyChanges(state, entry.changes), clone(document.state));
      this.persist();
      return clone(this.state);
    }
  }

  globalThis.ActivitySyncState = { Store, applyPending, applyChanges, changesBetween, emptyState, validState };
})();
