const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { BrowserController, buildRestorePlan, upsertTarget } = require('../electron/browser.cjs');
const { SessionManager } = require('../electron/session-manager.cjs');
const { writeJson } = require('../electron/storage.cjs');

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tabline-recovery-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const controller = new BrowserController(directory);
  controller.session = { id: randomUUID(), name: 'Research', browser: 'chrome', startedAt: 100, endedAt: null, activityHistory: [], tabs: [] };
  return { directory, controller, id: controller.session.id, file: path.join(directory, 'sessions', `${controller.session.id}.json`) };
}

test('continuous updates are recoverable before change events reach the UI', (context) => {
  const { directory, controller, id } = fixture(context);
  const storage = new BrowserController(directory);
  controller.on('change', () => {
    const recovered = storage.loadSession(id);
    assert.deepEqual(recovered.tabs[0].navigations, controller.session.tabs[0].navigations);
  });
  for (let index = 0; index < 20; index++) {
    upsertTarget(controller.session, { type: 'page', targetId: 'one', url: `https://example.com/${index}` }, 100 + index);
    controller.publish();
  }
  assert.equal(storage.loadSession(id).tabs[0].navigations.length, 20);
});

test('a forcibly killed tracking process retains its final published update', { timeout: 10000 }, async (context) => {
  const { directory, id } = fixture(context);
  const modulePath = path.join(__dirname, '..', 'electron', 'browser.cjs');
  const script = `
    const { BrowserController, upsertTarget } = require(${JSON.stringify(modulePath)});
    const controller = new BrowserController(process.argv[1]);
    controller.session = { id: process.argv[2], name: 'Killed session', browser: 'chrome', startedAt: Date.now(), endedAt: null, tabs: [] };
    for (let index = 0; index < 10; index++) {
      upsertTarget(controller.session, { type: 'page', targetId: 'one', url: 'https://example.com/' + index });
      controller.publish();
    }
    process.send('saved');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script, directory, id], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  context.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  assert.deepEqual(await once(child, 'message'), ['saved', undefined]);
  child.kill('SIGKILL');
  await exited;
  const manager = new SessionManager(directory);
  assert.equal(manager.listSessions().length, 1);
  const recovered = manager.loadSession(id);
  assert.equal(recovered.tabs[0].url, 'https://example.com/9');
  assert.equal(recovered.tabs[0].navigations.length, 10);
  assert.equal(recovered.recovered, true);
  assert.equal(buildRestorePlan(recovered).windows[0].tabs[0].url, 'https://example.com/9');
});

test('recovery preserves screenshots, activity, layout, and only tabs open at interruption', (context) => {
  const { directory, controller, id } = fixture(context);
  const open = upsertTarget(controller.session, { type: 'page', targetId: 'open', url: 'https://example.com' }, 110);
  const closed = upsertTarget(controller.session, { type: 'page', targetId: 'closed', url: 'https://closed.example' }, 120);
  Object.assign(open, { thumbnail: 'data:image/jpeg;base64,cHJldmlldw==', thumbnailAt: 130, pinned: true, groupId: 9, groupTitle: 'Research', groupColor: 'blue', windowId: '42', tabIndex: 0 });
  closed.closedAt = 140;
  closed.openAtEnd = false;
  controller.session.activityHistory.push({ at: 150, focusedWindowId: '42', windows: [{ windowId: '42', tabId: 'open' }] });
  controller.publish();
  const recovered = new BrowserController(directory).loadSession(id);
  assert.equal(recovered.endedAt, controller.session.savedAt);
  assert.equal(recovered.tabs[0].closedAt, recovered.endedAt);
  assert.equal(recovered.tabs[1].closedAt, 140);
  assert.equal(recovered.tabs[0].thumbnail, open.thumbnail);
  assert.deepEqual(recovered.activityHistory, controller.session.activityHistory);
  const plan = buildRestorePlan(recovered);
  assert.deepEqual(plan.windows[0].tabs.map((tab) => tab.sourceId), ['open']);
  assert.equal(plan.windows[0].tabs[0].pinned, true);
  assert.equal(plan.windows[0].tabs[0].groupTitle, 'Research');
});

for (const damage of ['truncated', 'invalid schema', 'missing']) {
  test(`a ${damage} session file falls back to the last complete backup`, (context) => {
    const { directory, controller, id, file } = fixture(context);
    controller.publish();
    controller.session.name = 'Second save';
    controller.publish();
    if (damage === 'missing') fs.unlinkSync(file);
    else fs.writeFileSync(file, damage === 'truncated' ? '{"id":' : '{}');
    fs.writeFileSync(`${file}.tmp`, '{');
    const recovered = new BrowserController(directory);
    assert.equal(recovered.listSessions().length, 1);
    assert.equal(recovered.loadSession(id).name, 'Research');
    recovered.renameSession(id, 'Recovered name');
    assert.equal(new BrowserController(directory).loadSession(id).name, 'Recovered name');
  });
}

for (const hasMain of [true, false]) {
  test(`a complete pending save is discoverable ${hasMain ? 'ahead of the older main file' : 'without a main file'}`, (context) => {
    const { directory, controller, id, file } = fixture(context);
    if (hasMain) controller.publish();
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...controller.session, name: 'Pending save', savedAt: 200 }));
    const recovered = new BrowserController(directory);
    assert.equal(recovered.listSessions().length, 1);
    assert.equal(recovered.loadSession(id).name, 'Pending save');
    assert.equal(recovered.loadSession(id).endedAt, 200);
  });
}

test('an interrupted legacy session includes activity and layout timestamps in recovery', (context) => {
  const { controller, id, file } = fixture(context);
  const open = upsertTarget(controller.session, { type: 'page', targetId: 'open', url: 'https://example.com' }, 110);
  const closed = upsertTarget(controller.session, { type: 'page', targetId: 'closed', url: 'https://closed.example' }, 120);
  delete open.openAtEnd;
  delete closed.openAtEnd;
  closed.closedAt = 130;
  controller.session.activityHistory.push({ at: 300, focusedWindowId: null, windows: [] });
  open.windowHistory.push({ at: 400, windowId: '1', desktopId: 'unknown' });
  open.orderHistory.push({ at: 500, windowId: 1, index: 2 });
  open.groupHistory.push({ at: 600, groupId: 3, title: 'Research', color: 'blue' });
  fs.writeFileSync(file, JSON.stringify(controller.session));
  const recovered = new BrowserController(controller.dataDir).loadSession(id);
  assert.equal(recovered.endedAt, 600);
  assert.deepEqual(buildRestorePlan(recovered).windows.flatMap((window) => window.tabs.map((tab) => tab.sourceId)), ['open']);
});

test('folder and ordering edits survive subsequent live-session autosaves', (context) => {
  const { directory, controller, id } = fixture(context);
  controller.publish();
  const storage = new BrowserController(directory);
  const folder = storage.createFolder('Research');
  storage.setSessionFolder(id, folder.id);
  controller.session.name = 'Still browsing';
  controller.publish();
  assert.equal(storage.listSessions()[0].folderId, folder.id);
  storage.deleteFolder(folder.id);
  controller.session.name = 'Another update';
  controller.publish();
  assert.equal(storage.listSessions()[0].folderId, null);
});

test('deletion removes recovery files so a session cannot reappear', (context) => {
  const { directory, controller, id, file } = fixture(context);
  controller.publish();
  controller.session.name = 'Second save';
  controller.publish();
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(controller.session));
  fs.writeFileSync(`${file}.bak.tmp`, JSON.stringify(controller.session));
  controller.deleteSession(id);
  assert.equal(new BrowserController(directory).listSessions().length, 0);
  assert.equal(fs.readdirSync(path.dirname(file)).length, 0);
});

test('failed saves report an error and retry without discarding the last valid data', (context) => {
  const { directory, controller, id, file } = fixture(context);
  controller.publish();
  fs.mkdirSync(`${file}.tmp`);
  const errors = [];
  controller.on('storage-error', (message) => errors.push(message));
  controller.session.name = 'Unsaved change';
  controller.publish();
  assert.equal(errors.length, 1);
  assert.equal(new BrowserController(directory).loadSession(id).name, 'Research');
  fs.rmdirSync(`${file}.tmp`);
  controller.publish();
  assert.equal(new BrowserController(directory).loadSession(id).name, 'Unsaved change');
});

test('folder and freezer data recover from interrupted or damaged writes', (context) => {
  const { directory, controller } = fixture(context);
  const folder = controller.createFolder('Research');
  controller.renameFolder(folder.id, 'New name');
  fs.writeFileSync(path.join(directory, 'folders.json'), '{');
  controller.freezer.whitelist.push('https://example.com');
  controller.persistFreezer();
  controller.freezer.entries.push({ slug: 'snapshot', screenshot: 'data:image/jpeg;base64,cHJldmlldw==' });
  writeJson(`${controller.freezerFile}.tmp`, controller.freezer);
  fs.writeFileSync(controller.freezerFile, '{');
  const recovered = new BrowserController(directory);
  assert.equal(recovered.listFolders()[0].name, 'Research');
  assert.deepEqual(recovered.freezer.whitelist, ['https://example.com']);
  assert.equal(recovered.freezer.entries[0].slug, 'snapshot');
});

test('stopping a session saves its final timeline synchronously', (context) => {
  const { directory, controller, id } = fixture(context);
  upsertTarget(controller.session, { type: 'page', targetId: 'open', url: 'https://example.com' }, 110);
  controller.finish();
  const saved = new BrowserController(directory).loadSession(id);
  assert.equal(saved.recovered, undefined);
  assert.equal(saved.endedAt, controller.session.endedAt);
  assert.equal(saved.tabs[0].openAtEnd, true);
});
