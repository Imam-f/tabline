const { app } = require('electron');
if (!process.env.TABLINE_SMOKE_DATA) throw new Error('Run this through desktop-smoke.cjs');
app.setPath('userData', process.env.TABLINE_SMOKE_DATA);
require('../electron/main.cjs');
