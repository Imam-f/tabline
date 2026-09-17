const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { CDP } = require('../electron/cdp.cjs');
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
    if (process.platform === 'win32') await waitFor(() => evaluate(`!document.querySelector('.timeline-group-heading')?.innerText.includes('Virtual desktop not available')`), 'native virtual desktop resolution');
    await evaluate(`document.querySelector('.tab-bar').click()`);
    await waitFor(() => evaluate(`document.querySelector('.detail-preview img')?.src.startsWith('data:image/jpeg')`), 'real screenshot in detail panel');
    await evaluate(`document.querySelector('.stop-button').click()`);
    await waitFor(() => evaluate(`document.querySelector('.modal h2')?.innerText === 'Call it a session?'`), 'end-session dialog');
    await evaluate(`document.querySelector('.modal-actions .primary').click()`);
    await waitFor(() => evaluate(`!document.querySelector('.live-badge') && !document.querySelector('.modal')`), 'session stopped');
    await evaluate(`[...document.querySelectorAll('.nav-item')].find(e=>e.innerText.includes('Saved sessions')).click()`);
    await waitFor(() => evaluate(`document.querySelectorAll('.saved-session').length === 1`), 'saved session list');
    await evaluate(`document.querySelector('.saved-session-view').click()`);
    await waitFor(() => evaluate(`!!document.querySelector('.tab-bar.is-closed')`), 'archived timeline reopened');
    await evaluate(`[...document.querySelectorAll('.nav-item')].find(e=>e.innerText.includes('Saved sessions')).click()`);
    await waitFor(() => evaluate(`!!document.querySelector('.restore-session:not(:disabled)')`), 'restore action');
    await evaluate(`document.querySelector('.restore-session').click()`);
    await waitFor(() => evaluate(`!!document.querySelector('.live-badge') && document.querySelector('.tab-bar')?.title.includes('Desktop integration page')`), 'saved session restored into a new live browser', 40000);
    await evaluate(`window.tabline.stop()`);
    await waitFor(() => evaluate(`!document.querySelector('.live-badge')`), 'restored session stopped');
    assert.deepEqual(rendererErrors, [], 'production renderer should have no uncaught errors');
    console.log('PASS: production Electron window, sandboxed preload, browser launch through UI, live timeline, thumbnail, stop, save, reopen, and restore.');
  } finally {
    if (evaluate) await evaluate(`window.tabline.stop()`).catch(() => {});
    client?.close();
    child.kill();
    await new Promise((resolve) => server.close(resolve));
    await delay(1000);
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { console.log(`Temporary desktop profile remains at ${dataDir}`); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
