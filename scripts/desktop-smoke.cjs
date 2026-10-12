const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { CDP } = require('../electron/cdp.cjs');
const { NetworkManager } = require('../electron/network.cjs');
const electron = require('electron');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeout = 25000) {
  for (const start = Date.now(); Date.now() - start < timeout;) {
    const value = await predicate();
    if (value) return value;
    await delay(150);
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.TABLINE_TEST_TEMP || os.tmpdir(), 'tabline-desktop-'));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<html><head><title>Desktop integration page</title></head><body style="font:24px system-ui;background:#f3f5e8;padding:60px"><h1>Hello from Tabline</h1></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, TABLINE_SMOKE_DATA: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TABLINE_DEV;
  const child = spawn(electron, ['scripts/desktop-harness.cjs', '--remote-debugging-port=0'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let client;
  let sessionId;
  let evaluate;
  let peerNetwork;
  try {
    const endpoint = await waitFor(() => output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'Electron debug endpoint', 40000);
    client = new CDP(endpoint);
    await client.connect();
    const target = await waitFor(async () => (await client.send('Target.getTargets')).targetInfos.find((item) => item.type === 'page' && item.url.startsWith('file:')), 'production renderer');
    ({ sessionId } = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
    const rendererErrors = [];
    client.on('Runtime.exceptionThrown', (event) => rendererErrors.push(event.exceptionDetails.text));
    await client.send('Runtime.enable', {}, sessionId);
    evaluate = async (expression) => {
      const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await waitFor(() => evaluate(`!!document.querySelector('.launch-empty') && typeof window.tabline?.launch === 'function'`), 'sandboxed bridge and empty state');
    assert.equal(await evaluate(`typeof require`), 'undefined', 'Node integration must be disabled');
    await evaluate(`document.querySelector('.page-heading .primary').click()`);
    await waitFor(() => evaluate(`!!document.querySelector('.modal')`), 'launcher dialog');
    await waitFor(() => evaluate(`document.querySelector('.browser-option.selected')?.innerText.includes('Detected')`), 'detected browser');
    const localUrl = `http://127.0.0.1:${server.address().port}`;
    await evaluate(`(() => { const input=document.querySelector('#start-url'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(localUrl)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await delay(100);
    await evaluate(`document.querySelector('.launch-submit').click()`);
    await waitFor(() => evaluate(`!!document.querySelector('.live-badge') && document.querySelector('.tab-bar')?.title.includes('Desktop integration page')`), 'real browser tab in live renderer');
    await waitFor(() => evaluate(`document.querySelector('.activity-row-summary')?.innerText.includes('Desktop integration page')`), 'active tab in the per-second activity row');
    if (process.platform === 'win32') await waitFor(() => evaluate(`!document.querySelector('.timeline-group-heading')?.innerText.includes('Virtual desktop not available')`), 'native virtual desktop resolution');
    await evaluate(`document.querySelector('.tab-bar').click()`);
    await waitFor(() => evaluate(`document.querySelector('.detail-preview img')?.src.startsWith('data:image/jpeg')`), 'real screenshot in detail panel');
    await evaluate(`document.querySelector('.stop-button').click()`);
    await waitFor(() => evaluate(`document.querySelector('.modal h2')?.innerText === 'Call it a session?'`), 'end-session dialog');
    await evaluate(`document.querySelector('.modal-actions .primary').click()`);
    await waitFor(() => evaluate(`!document.querySelector('.live-badge') && !document.querySelector('.modal')`), 'session stopped');
    await evaluate(`[...document.querySelectorAll('.nav-item')].find(e=>e.innerText.includes('Saved sessions')).click()`);
    await waitFor(() => evaluate(`document.querySelectorAll('.saved-session').length === 1`), 'saved session list');
    await evaluate(`document.querySelector('.saved-session-view').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    await waitFor(() => evaluate(`!!document.querySelector('.tab-bar.is-closed')`), 'archived timeline reopened');
    const fileSource = await evaluate(`window.tabline.listSessions().then(sessions => window.tabline.loadSession(sessions[0].id))`);
    const importFile = path.join(dataDir, 'import-session.json');
    const importDialog = path.join(dataDir, 'import-dialog.json');
    fs.writeFileSync(importFile, JSON.stringify(fileSource));
    fs.writeFileSync(importDialog, JSON.stringify({ canceled: false, filePaths: [importFile] }));
    await evaluate(`[...document.querySelectorAll('.nav-item')].find(e=>e.innerText.includes('Saved sessions')).click()`);
    await waitFor(() => evaluate(`document.querySelectorAll('.saved-session').length === 1`), 'original session before import');
    const clickImport = () => evaluate(`[...document.querySelectorAll('.section-heading-actions button')].find(e=>e.innerText==='Import session').click()`);
    await clickImport();
    await waitFor(() => evaluate(`document.querySelectorAll('.saved-session').length === 2 && document.querySelector('.toast')?.innerText.includes('Imported')`), 'local file import in saved sessions');
    const localCopy = await evaluate(`window.tabline.listSessions().then(sessions => window.tabline.loadSession(sessions.find(s=>s.id!==${JSON.stringify(fileSource.id)}).id))`);
    assert.deepEqual(localCopy.tabs, fileSource.tabs);
    assert.notEqual(localCopy.id, fileSource.id);
    fs.writeFileSync(importDialog, JSON.stringify({ canceled: true, filePaths: [] }));
    assert.equal(await evaluate(`window.tabline.importSession()`), null, 'canceling the file picker should not create a session');
    fs.writeFileSync(importFile, '{broken JSON');
    fs.writeFileSync(importDialog, JSON.stringify({ canceled: false, filePaths: [importFile] }));
    await clickImport();
    await waitFor(() => evaluate(`document.querySelector('.toast')?.innerText.includes('not valid JSON')`), 'file import error shown in UI');
    assert.equal(await evaluate(`window.tabline.listSessions().then(sessions=>sessions.length)`), 2);
    await evaluate(`document.querySelector('.saved-session.selected .saved-session-view').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    await waitFor(() => evaluate(`!!document.querySelector('.tab-bar.is-closed')`), 'imported timeline opened');
    await evaluate(`[...document.querySelectorAll('.nav-item')].find(e=>e.innerText.includes('Saved sessions')).click()`);
    await waitFor(() => evaluate(`!!document.querySelector('.restore-session:not(:disabled)')`), 'restore action');
    await evaluate(`document.querySelector('.restore-session').click()`);
    await waitFor(() => evaluate(`!!document.querySelector('.live-badge') && document.querySelector('.tab-bar')?.title.includes('Desktop integration page')`), 'saved session restored into a new live browser', 40000);
    await waitFor(() => evaluate(`document.querySelector('.toast')?.innerText.includes('Restored 1 tab')`), 'restore completion', 40000);
    if (process.platform === 'win32') assert.equal(await evaluate(`document.querySelector('.toast')?.innerText.includes('virtual desktop placement was unavailable')`), false, 'restored window should return to its saved virtual desktop');
    await evaluate(`window.tabline.stop()`);
    await waitFor(() => evaluate(`!document.querySelector('.live-badge')`), 'restored session stopped');
    // Client mode must wait, then restore its own saved data on an authenticated request.
    const networkPort = await freePort();
    const savedSessionId = await evaluate(`window.tabline.listSessions().then(sessions => sessions[0].id)`);
    const networkConfig = await evaluate(`window.tabline.getNetwork().then(state => state.config)`);
    await evaluate(`window.tabline.configureNetwork(${JSON.stringify({ ...networkConfig, mode: 'client', port: networkPort })})`);
    await evaluate(`[...document.querySelectorAll('.nav-item')].find(e=>e.innerText.includes('Network instances')).click()`);
    await waitFor(() => evaluate(`document.querySelector('.network-status')?.innerText.includes('waiting for a restore request')`), 'client waiting status in network UI');
    assert.equal(await evaluate(`window.tabline.getState().then(state => state.sessions.filter(s=>s.status==='live').length)`), 0, 'client mode should not launch a browser until requested');
    const restoreResponse = await fetch(`http://127.0.0.1:${networkPort}/v1/restore`, { method: 'POST', headers: { Authorization: `Bearer ${networkConfig.token}` }, body: JSON.stringify({ sessionId: savedSessionId }) });
    assert.equal(restoreResponse.status, 200);
    assert.equal((await restoreResponse.json()).opened, 1);
    assert.equal(await evaluate(`window.tabline.getState().then(state => state.session.restoredFromSessionId)`), savedSessionId);
    assert.equal(await evaluate(`window.tabline.getState().then(state => state.status)`), 'live');
    await evaluate(`window.tabline.stop()`);
    // A second instance's timeline should update without enabling local browser controls.
    const remoteSession = await evaluate(`window.tabline.loadSession(${JSON.stringify(savedSessionId)})`);
    remoteSession.name = 'Remote fixture session';
    remoteSession.endedAt = null;
    remoteSession.tabs.forEach((tab) => { tab.closedAt = null; });
    const remoteState = { status: 'live', session: remoteSession, sessions: [{ status: 'live', session: remoteSession, debugPort: null }], debugPort: null, activeSessionId: remoteSession.id, error: null };
    peerNetwork = new NetworkManager({ snapshot: () => remoteState, listSessions: () => [{ id: remoteSession.id, name: remoteSession.name, tabCount: remoteSession.tabs.length, startedAt: remoteSession.startedAt }] }, path.join(dataDir, 'peer-network'));
    const peerPort = await freePort();
    await peerNetwork.configure({ ...peerNetwork.config, mode: 'host', name: 'Remote test machine', port: peerPort });
    await evaluate(`window.tabline.configureNetwork(${JSON.stringify({ ...networkConfig, mode: 'client', port: networkPort, peers: [{ id: 'smoke-peer', url: `http://127.0.0.1:${peerPort}`, token: peerNetwork.config.token }] })})`);
    await waitFor(() => evaluate(`document.querySelector('.network-instance h3')?.innerText === 'Remote test machine'`), 'connected instance in network UI');
    await evaluate(`document.querySelector('.network-session button').click()`);
    await waitFor(() => evaluate(`document.querySelector('.session-title .badge')?.innerText === 'REMOTE LIVE'`), 'remote timeline selected');
    assert.equal(await evaluate(`!!document.querySelector('.stop-button') || !!document.querySelector('.restore-session-inline')`), false, 'remote timelines must not control a local session');
    remoteSession.tabs[0].title = 'Live change from another machine';
    await waitFor(() => evaluate(`document.querySelector('.tab-bar')?.title.includes('Live change from another machine')`), 'remote timeline updates automatically');
    await evaluate(`[...document.querySelectorAll('.nav-item')].find(e=>e.innerText.includes('Network instances')).click()`);
    await waitFor(() => evaluate(`!!document.querySelector('.network-session-actions')`), 'remote session import controls');
    await evaluate(`[...document.querySelectorAll('.network-session-actions button')].filter(e=>e.innerText==='Import to this device').at(-1).click()`);
    await waitFor(() => evaluate(`document.querySelector('.toast')?.innerText.includes('Imported') && !!document.querySelector('.saved-session.selected')`), 'remote saved session imported locally');
    const remoteCopyId = await evaluate(`window.tabline.listSessions().then(sessions=>sessions.find(s=>s.name==='Remote fixture session').id)`);
    assert.notEqual(remoteCopyId, remoteSession.id);
    await evaluate(`document.querySelector('.saved-session.selected .saved-session-view').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    await waitFor(() => evaluate(`document.querySelector('.tab-bar')?.title.includes('Live change from another machine') && document.querySelector('.session-title .badge')?.innerText === 'SAVED'`), 'remote import opens as a local archived timeline');
    await evaluate(`document.querySelector('.restore-session-inline').click()`);
    await waitFor(() => evaluate(`document.querySelector('.toast')?.innerText.includes('Restored 1 tab')`), 'remote imported session restored on this device', 40000);
    assert.equal(await evaluate(`window.tabline.getState().then(state=>state.session.restoredFromSessionId)`), remoteCopyId);
    await evaluate(`window.tabline.stop()`);
    await evaluate(`[...document.querySelectorAll('.nav-item')].find(e=>e.innerText.includes('Network instances')).click()`);
    await waitFor(() => evaluate(`!!document.querySelector('.network-session button')`), 'remote timeline available after local restore');
    await evaluate(`document.querySelector('.network-session button').click()`);
    await waitFor(() => evaluate(`document.querySelector('.session-title .badge')?.innerText === 'REMOTE LIVE'`), 'remote monitoring resumed after import');
    peerNetwork.stop();
    await waitFor(() => evaluate(`document.querySelector('.session-title .badge')?.innerText === 'OFFLINE'`), 'remote timeline marked offline');
    assert.equal(await evaluate(`document.querySelector('.tab-bar')?.title.includes('Live change from another machine')`), true, 'last remote snapshot should remain visible offline');
    await evaluate(`document.querySelector('[aria-label="Return to current session"]').click()`);
    assert.equal(await evaluate(`!!document.querySelector('.network-view-banner')`), false);
    await evaluate(`window.tabline.configureNetwork(${JSON.stringify({ ...networkConfig, mode: 'off', port: networkPort })})`);
    assert.deepEqual(rendererErrors, [], 'production renderer should have no uncaught errors');
    console.log('PASS: production Electron UI, live tracking, local file import and errors, remote import and local restore, client waiting and network resume, remote timeline updates, and offline state.');
  } finally {
    if (evaluate) await evaluate(`window.tabline.stop()`).catch(() => {});
    client?.close();
    child.kill();
    peerNetwork?.stop();
    await new Promise((resolve) => server.close(resolve));
    await delay(1000);
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { console.log(`Temporary desktop profile remains at ${dataDir}`); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
