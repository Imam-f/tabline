const fs = require('node:fs');
const path = require('node:path');

// A completed temporary file is newer than the main file. A truncated one is
// ignored, leaving the main file (or its previous version) available to recover.
function readJson(file, validate = () => true) {
  let lastError;
  for (const candidate of [`${file}.tmp`, file, `${file}.bak`]) {
    try {
      const value = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (!validate(value)) throw new Error(`Invalid data in ${candidate}`);
      return value;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

function writeFlushed(file, contents) {
  const descriptor = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function writeJson(file, value, validate = () => true) {
  const contents = JSON.stringify(value);
  let previous;
  try { previous = readJson(file, validate); }
  catch (error) {
    // Missing or damaged data can be replaced; access and I/O failures cannot.
    if (error.code && error.code !== 'ENOENT') throw error;
  }
  if (previous !== undefined) {
    writeFlushed(`${file}.bak.tmp`, JSON.stringify(previous));
    fs.renameSync(`${file}.bak.tmp`, `${file}.bak`);
  }
  writeFlushed(`${file}.tmp`, contents);
  fs.renameSync(`${file}.tmp`, file);
  // Windows does not support opening directories for fsync. On POSIX, flush
  // the replacement directory entry as well as the file contents.
  if (process.platform !== 'win32') {
    const descriptor = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
  }
}

function jsonFiles(directory) {
  return [...new Set(fs.readdirSync(directory).flatMap((name) => {
    const match = name.match(/^(.*\.json)(?:\.tmp|\.bak)?$/);
    return match ? [match[1]] : [];
  }))];
}

function deleteJson(file) {
  for (const suffix of ['', '.tmp', '.bak', '.bak.tmp']) fs.rmSync(`${file}${suffix}`, { force: true });
}

module.exports = { readJson, writeJson, jsonFiles, deleteJson };
