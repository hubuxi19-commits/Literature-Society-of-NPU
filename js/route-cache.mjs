export function createRouteCache({
  maxEntries = 24,
  ttlMs = 5 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();

  function get(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < now()) {
      entries.delete(key);
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function set(key, value) {
    entries.delete(key);
    entries.set(key, { value, expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
    return value;
  }

  return {
    get,
    set,
    delete(key) {
      return entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}
