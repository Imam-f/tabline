const test = require('node:test');
const assert = require('node:assert/strict');
const { MirrorRoom } = require('../electron/mirror-room.cjs');

function initial() {
  return { sourceSessionId: 'source', windows: [{ sourceWindowId: 'window', desktopIndex: 0, focused: true, tabs: [
    { sourceId: 'a', url: 'https://a.example/', index: 0, pinned: false, active: true },
    { sourceId: 'b', url: 'https://b.example/', index: 1, pinned: false, active: false },
  ] }] };
}
const tab = (plan, id) => plan.windows.flatMap((window) => window.tabs).find((item) => item.sourceId === id);

test('independent simultaneous browser edits merge and unchanged baselines do not echo', () => {
  const room = new MirrorRoom(initial());
  const base = room.snapshot();
  const left = structuredClone(base);
  const right = structuredClone(base);
  tab(left, 'a').url = 'https://left.example/';
  tab(right, 'b').url = 'https://right.example/';
  room.sync(base, left);
  const result = room.sync(base, right);
  assert.equal(tab(result, 'a').url, 'https://left.example/');
  assert.equal(tab(result, 'b').url, 'https://right.example/');
  const unchanged = room.sync(base, base);
  assert.deepEqual(unchanged.windows, result.windows);
});

test('tab closure wins over a concurrent update without resurrecting the tab', () => {
  const room = new MirrorRoom(initial());
  const base = room.snapshot();
  const closed = structuredClone(base);
  closed.windows[0].tabs = closed.windows[0].tabs.filter((item) => item.sourceId !== 'a');
  room.sync(base, closed);
  const edited = structuredClone(base);
  tab(edited, 'a').url = 'https://late.example/';
  assert.equal(tab(room.sync(base, edited), 'a'), undefined);
});

test('new windows, tab moves, active tab changes and desktop numbers synchronize together', () => {
  const room = new MirrorRoom(initial());
  const base = room.snapshot();
  const observed = structuredClone(base);
  const moved = observed.windows[0].tabs.pop();
  moved.active = true;
  observed.windows.push({ sourceWindowId: 'local:new-window', desktopIndex: 3, focused: true, tabs: [moved] });
  observed.windows[0].focused = false;
  const result = room.sync(base, observed);
  assert.equal(result.windows[1].sourceWindowId, 'local:new-window');
  assert.equal(result.windows[1].tabs[0].sourceId, 'b');
  assert.equal(result.windows[1].desktopIndex, 3);
  assert.equal(result.windows[0].focused, false);
  const echoed = room.sync(result, result);
  assert.deepEqual(echoed.windows, result.windows);
});

test('conflicts use receipt order and invalid updates leave the room unchanged', () => {
  const room = new MirrorRoom(initial());
  const base = room.snapshot();
  const one = structuredClone(base);
  const two = structuredClone(base);
  tab(one, 'a').url = 'https://one.example/';
  tab(two, 'a').url = 'https://two.example/';
  room.sync(base, one);
  assert.equal(tab(room.sync(base, two), 'a').url, 'https://two.example/');
  const before = room.snapshot();
  const invalid = structuredClone(base);
  tab(invalid, 'a').url = 'file:///private';
  assert.throws(() => room.sync(base, invalid), /Only web URLs/);
  assert.deepEqual(room.snapshot(), before);
});
