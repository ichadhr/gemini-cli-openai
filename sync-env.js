/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');

const devVars = fs.readFileSync('.dev.vars', 'utf8')
  .split('\n')
  .filter(line => line.includes('=') && !line.startsWith('#'));

const vars = {};
devVars.forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) {
    vars[key.trim()] = value.trim().replace(/^['"]|['"]$/g, '');
  }
});

let toml = fs.readFileSync('wrangler.toml', 'utf8');
const varsSection = Object.entries(vars)
  .filter(([k]) => !k.includes('GCP_SERVICE_ACCOUNT') && k !== 'OPENAI_API_KEY')
  .map(([k, v]) => `${k} = "${v}"`)
  .join('\n');

// Replace the entire [vars] section
const updated = toml.replace(/(\[vars\])[\s\S]*?(?=\n\n|\n\[|$)/, '$1\n' + varsSection);
fs.writeFileSync('wrangler.toml', updated);

console.log('Environment synced to wrangler.toml');
