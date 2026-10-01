// Clear cPanel/Passenger's NODE_PATH so standalone server uses its own bundled modules
delete process.env.NODE_PATH;
// Re-initialize Node.js module search paths without the virtual env
const Module = require('module');
Module._initPaths();

// Force production mode before loading anything
process.env.NODE_ENV = 'production';

// The generated standalone server changes its application directory and does
// not reliably discover the source project's .env.local. Load it explicitly
// before booting while preserving variables supplied by the host environment.
const fs = require('fs');
const path = require('path');
for (const envFile of ['.env.production.local', '.env.local', '.env.production', '.env']) {
  const envPath = path.join(__dirname, envFile);
  if (!fs.existsSync(envPath)) continue;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

// Load the Next.js standalone server (self-contained, no TypeScript checks)
require('./.next/standalone/server.js');
