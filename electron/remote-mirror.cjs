const { buildRestorePlan } = require('./browser.cjs');

function buildMirrorPlan(session) {
  const tabs = session.tabs.filter((tab) => !tab.closedAt).map((tab) => {
    const candidate = tab.originalUrl || tab.url;
    let url = 'about:blank';
    try { const parsed = new URL(candidate); if (['http:', 'https:'].includes(parsed.protocol)) url = parsed.href; } catch {}
    return { ...tab, url, originalUrl: null, openAtEnd: true };
  });
  const plan = buildRestorePlan({ ...session, tabs }, null, tabs.length);
  for (const window of plan.windows) {
    delete window.desktopId;
    const members = tabs.filter((tab) => String(tab.extensionWindowId ?? tab.windowId ?? 'default') === window.sourceWindowId);
    window.desktopIndex = Number.isInteger(members[0]?.desktopIndex) && members[0].desktopIndex >= 0 ? members[0].desktopIndex : null;
    window.focused = members.some((tab) => tab.focused);
  }
  return plan;
}

module.exports = { buildMirrorPlan };
