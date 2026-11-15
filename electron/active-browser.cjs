const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');

const debuggingPage = 'chrome://inspect/#remote-debugging';
const debuggingHelp = 'Enable remote debugging in the browser tab, then try again. Click Allow when your browser asks to allow debugging. If this browser version has no remote debugging checkbox, use a browser with that feature or an existing local debugging port.';

function profileCandidates(browser, platform = process.platform, env = process.env, home = os.homedir()) {
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  if (platform === 'win32') return browser === 'chrome'
    ? [path.join(local, 'Google', 'Chrome', 'User Data')]
    : [path.join(local, 'imput', 'Helium', 'User Data'), path.join(local, 'Helium', 'User Data'), path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'helium')];
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', browser === 'chrome' ? 'Google/Chrome' : 'net.imput.helium')];
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return browser === 'chrome' ? [path.join(config, 'google-chrome'), path.join(config, 'chromium')] : [path.join(config, 'net.imput.helium'), path.join(config, 'helium')];
}

function localEndpoint(input, protocols = ['ws:']) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Enter a valid local debugging address.'); }
  if (!protocols.includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash) {
    throw new Error('Use a localhost debugging address with a port, such as http://127.0.0.1:9222.');
  }
  if (url.protocol === 'ws:' && !/^\/devtools\/browser(?:\/[a-zA-Z0-9_-]+)?\/?$/.test(url.pathname)) throw new Error('Use the browser debugging endpoint, not an individual tab endpoint.');
  // Canonicalize localhost so duplicate-session checks use the same identity.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.href;
}

async function resolveActiveEndpoint(options = {}) {
  if (options.address?.trim()) {
    const address = localEndpoint(options.address.trim(), ['http:', 'ws:']);
    if (address.startsWith('ws:')) return address;
    const base = new URL(address);
    let data;
    try {
      const response = await fetch(new URL('/json/version', base), { signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (!response.ok) throw new Error('Debugging endpoint unavailable.');
      data = await response.json();
    } catch {
      const error = new Error(`The debugging address is unavailable. ${debuggingHelp}`);
      error.code = 'DEBUGGING_UNAVAILABLE';
      throw error;
    }
    const endpoint = localEndpoint(data.webSocketDebuggerUrl);
    const target = new URL(endpoint);
    if (target.hostname !== base.hostname || target.port !== base.port) throw new Error('The browser returned a different debugging address.');
    return endpoint;
  }
  const profiles = options.userDataDir?.trim() ? [path.resolve(options.userDataDir.trim())] : profileCandidates(options.browser);
  for (const profile of profiles) {
    try {
      const [port, endpoint] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) continue;
      return localEndpoint(`ws://127.0.0.1:${port}${endpoint}`);
    } catch {}
  }
  const error = new Error(`Remote debugging is not enabled or its profile could not be found. ${debuggingHelp} For a custom profile, enter its User Data directory under connection settings.`);
  error.code = 'DEBUGGING_UNAVAILABLE';
  throw error;
}

function openDebuggingSettings(options, browsers) {
  const executable = options.executable || browsers.find((item) => item.id === options.browser)?.path;
  if (!executable || !fs.existsSync(executable)) throw new Error(`Choose your browser executable, or open ${debuggingPage} in your browser. ${debuggingHelp}`);
  const args = options.userDataDir?.trim() ? [`--user-data-dir=${path.resolve(options.userDataDir.trim())}`] : [];
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(executable, [...args, debuggingPage], { stdio: 'ignore', detached: true, windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

module.exports = { resolveActiveEndpoint, profileCandidates, localEndpoint, openDebuggingSettings, debuggingHelp };
