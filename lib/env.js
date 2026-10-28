const fs = require('node:fs');
const path = require('node:path');

function loadLocalEnv(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return false;
  for (const sourceLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = sourceLine.trim().replace(/^export\s+/, '');
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || match[2].startsWith('#') || process.env[match[1]]?.trim()) continue;
    const value = match[2].replace(/^(?:"(.*)"|'(.*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted).trim();
    process.env[match[1]] = value;
  }
  return true;
}

module.exports = { loadLocalEnv };
