const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
if (!process.env.TABLINE_SMOKE_DATA) throw new Error('Run this through desktop-smoke.cjs');
app.setPath('userData', process.env.TABLINE_SMOKE_DATA);
// Exercise the production import IPC without opening an interactive OS picker.
const showOpenDialog = dialog.showOpenDialog.bind(dialog);
dialog.showOpenDialog = (window, options) => {
  if (options.title !== 'Import session') return showOpenDialog(window, options);
  return Promise.resolve(JSON.parse(fs.readFileSync(path.join(process.env.TABLINE_SMOKE_DATA, 'import-dialog.json'), 'utf8')));
};
require('../electron/main.cjs');
