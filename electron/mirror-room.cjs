const { randomUUID } = require('node:crypto');

const tabFields = ['url', 'pinned', 'active', 'index', 'windowId'];
const windowFields = ['desktopIndex', 'focused'];
function flatten(plan) {
  if (!plan || !Array.isArray(plan.windows) || plan.windows.length > 250) throw new Error('Invalid mirror layout.');
  const windows = new Map();
  const tabs = new Map();
  for (const window of plan.windows) {
    const id = window.sourceWindowId;
    if (typeof id !== 'string' || id.length > 200 || windows.has(id) || !Array.isArray(window.tabs)) throw new Error('Invalid mirror window.');
    if (window.desktopIndex != null && (!Number.isInteger(window.desktopIndex) || window.desktopIndex < 0 || window.desktopIndex > 255)) throw new Error('Invalid desktop number.');
    windows.set(id, { desktopIndex: window.desktopIndex ?? null, focused: !!window.focused });
    for (const tab of window.tabs) {
      if (typeof tab.sourceId !== 'string' || tab.sourceId.length > 200 || tabs.has(tab.sourceId) || tabs.size >= 2000) throw new Error('Invalid mirror tab.');
      let url;
      try { url = new URL(tab.url); } catch { throw new Error('Invalid mirror URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) && tab.url !== 'about:blank') throw new Error('Only web URLs or a blank page can be mirrored.');
      if (!Number.isInteger(tab.index) || tab.index < 0) throw new Error('Invalid tab position.');
      tabs.set(tab.sourceId, { url: url.href, pinned: !!tab.pinned, active: !!tab.active, index: tab.index, windowId: id });
    }
  }
  return { windows, tabs };
}

class MirrorRoom {
  constructor(plan) {
    this.id = randomUUID();
    this.sourceSessionId = plan.sourceSessionId;
    this.layout = flatten(plan);
    this.revision = 1;
    this.clients = new Set();
  }

  snapshot() {
    return { sourceSessionId: this.sourceSessionId, roomId: this.id, twoWay: true, revision: this.revision, windows: [...this.layout.windows].map(([sourceWindowId, window]) => ({
      sourceWindowId, ...window,
      tabs: [...this.layout.tabs].filter(([, tab]) => tab.windowId === sourceWindowId).sort((a, b) => Number(b[1].pinned) - Number(a[1].pinned) || a[1].index - b[1].index || a[0].localeCompare(b[0])).map(([sourceId, tab], index) => ({ sourceId, ...tab, index })),
    })).filter((window) => window.tabs.length) };
  }

  sync(basePlan, observedPlan) {
    // Apply only edits relative to this browser's last applied observation.
    // Remote changes therefore never echo back as new edits. Deletions win over
    // concurrent updates; conflicting field edits use server receipt order.
    const base = flatten(basePlan);
    const observed = flatten(observedPlan);
    for (const [id, window] of observed.windows) {
      const previous = base.windows.get(id);
      const current = this.layout.windows.get(id);
      if (!previous) this.layout.windows.set(id, { ...window });
      else if (current) for (const field of windowFields) if (window[field] !== previous[field]) current[field] = window[field];
    }
    for (const id of base.tabs.keys()) if (!observed.tabs.has(id)) this.layout.tabs.delete(id);
    for (const [id, tab] of observed.tabs) {
      const previous = base.tabs.get(id);
      const current = this.layout.tabs.get(id);
      if (!previous) this.layout.tabs.set(id, { ...tab });
      else if (current) for (const field of tabFields) if (tab[field] !== previous[field]) current[field] = tab[field];
      if (tab.active && (!previous || !previous.active || previous.windowId !== tab.windowId)) {
        for (const [otherId, other] of this.layout.tabs) if (otherId !== id && other.windowId === tab.windowId) other.active = false;
      }
    }
    for (const [id, window] of observed.windows) if (window.focused && !base.windows.get(id)?.focused) {
      for (const [otherId, other] of this.layout.windows) if (otherId !== id) other.focused = false;
    }
    for (const id of this.layout.windows.keys()) if (![...this.layout.tabs.values()].some((tab) => tab.windowId === id)) this.layout.windows.delete(id);
    // A tab moved into a concurrently deleted window retains that destination.
    for (const tab of this.layout.tabs.values()) if (!this.layout.windows.has(tab.windowId)) this.layout.windows.set(tab.windowId, observed.windows.get(tab.windowId) || { desktopIndex: null, focused: false });
    this.revision++;
    return this.snapshot();
  }
}

module.exports = { MirrorRoom, flatten };
