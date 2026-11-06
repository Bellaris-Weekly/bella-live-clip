// Owners are laid-out comments, so identical text in different lanes/colors
// never shares raster state. Retain only visible owners and a bounded LRU.
export function createSpriteCache({maxBytes = 32 * 1024 * 1024, metrics} = {}) {
  const entries = new Set(),
    owners = new WeakMap();
  let bytes = 0;
  const release = entry => {
    entry.image.close();
    bytes -= entry.bytes;
    entries.delete(entry);
    const parts = owners.get(entry.owner);
    parts.delete(entry.part);
    if (!parts.size) owners.delete(entry.owner);
    metrics?.gauge('spriteBytes', bytes);
  };
  return {
    get(owner, part, create) {
      const cached = owners.get(owner)?.get(part);
      if (cached) {
        entries.delete(cached);
        entries.add(cached);
        metrics?.add('spriteHits');
        return cached;
      }
      const sprite = create(maxBytes);
      if (!sprite) return null;
      while (bytes + sprite.bytes > maxBytes && entries.size) release(entries.values().next().value);
      const entry = {...sprite, owner, part};
      let parts = owners.get(owner);
      if (!parts) owners.set(owner, (parts = new Map()));
      parts.set(part, entry);
      entries.add(entry);
      bytes += sprite.bytes;
      metrics?.add('spriteRasters');
      metrics?.gauge('spriteBytes', bytes);
      return entry;
    },
    delete(owner) {
      const parts = owners.get(owner);
      if (parts) for (const entry of parts.values()) release(entry);
    },
    retain(owners) {
      const active = new Set(owners);
      for (const entry of entries) if (!active.has(entry.owner)) release(entry);
    },
    clear() {
      for (const entry of entries) release(entry);
    },
  };
}
