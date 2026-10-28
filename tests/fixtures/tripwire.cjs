// Test stub. If any detection code invokes a stubbed executable, this runs
// first (via NODE_OPTIONS=--require) and leaves a marker file behind.
const fs = require('node:fs');

if (process.env.ZIKI_TRIPWIRE) {
  fs.writeFileSync(process.env.ZIKI_TRIPWIRE, 'invoked\n');
}

process.exit(0);
