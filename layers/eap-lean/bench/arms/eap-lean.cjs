// EAP-Lean arm: the layer's own EAP-LEAN.md rule as the system prompt. Single source of truth.
const fs = require('fs');
const path = require('path');
const system = fs.readFileSync(path.join(__dirname, '..', '..', 'EAP-LEAN.md'), 'utf8');
module.exports = ({ vars }) => [
  { role: 'system', content: system },
  { role: 'user', content: vars.task },
];
