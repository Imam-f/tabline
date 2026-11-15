// Chrome ignores --load-extension in branded builds. Its extension-loading
// protocol command is available only over the inherited debugging pipe.
function loadCompanion(child, extensionPath, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const input = child.stdio[3];
    const output = child.stdio[4];
    let buffer = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.removeListener('data', onData);
      output.removeListener('error', onError);
      output.removeListener('close', onClose);
      input.removeListener('error', onError);
      if (error) reject(error); else resolve(result);
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error('Browser closed its extension-loading connection.'));
    const onData = (chunk) => {
      buffer += chunk.toString();
      let boundary;
      while ((boundary = buffer.indexOf('\0')) >= 0) {
        let message;
        try { message = JSON.parse(buffer.slice(0, boundary)); }
        catch { finish(new Error('Invalid response from the extension-loading connection.')); return; }
        buffer = buffer.slice(boundary + 1);
        if (message.id === 1) finish(message.error ? new Error(message.error.message) : null, message.result);
      }
    };
    const timer = setTimeout(() => finish(new Error('Browser did not load the Tabline companion.')), timeout);
    output.on('data', onData);
    output.once('error', onError);
    output.once('close', onClose);
    input.once('error', onError);
    input.write(`${JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: extensionPath } })}\0`, (error) => { if (error) finish(error); });
  });
}

module.exports = { loadCompanion };
