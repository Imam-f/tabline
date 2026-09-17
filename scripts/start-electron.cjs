const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

// Electron-based terminals can inherit this flag from their own parent process.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes('--dev')) env.TABLINE_DEV = '1';
else delete env.TABLINE_DEV;
const child = spawn(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'inherit' });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code || 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
