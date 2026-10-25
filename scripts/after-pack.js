// Wrap the Electron binary in a launcher that passes --no-sandbox (the AppImage can't ship a suid chrome-sandbox).
const fs = require('fs');
const path = require('path');
exports.default = async function (ctx) {
  const dir = ctx.appOutDir;
  const bin = path.join(dir, 'slytp');
  fs.renameSync(bin, bin + '-bin');
  fs.writeFileSync(bin, '#!/bin/bash\nexec "$(dirname "$(readlink -f "$0")")/slytp-bin" --no-sandbox "$@"\n', { mode: 0o755 });
};
