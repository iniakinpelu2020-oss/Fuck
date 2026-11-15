const fs = require('fs');
let s = fs.readFileSync('js/agent.js', 'utf8');

// FIX 4 was wrong — gemini/anthropic have default endpoints, they shouldn't require override
const old4 = "        if (dprov === 'custom' || dprov === 'gemini' || dprov === 'anthropic') {";
const new4 = "        if (dprov === 'custom') {";
if (s.includes(old4)) {
  s = s.replace(old4, new4);
  console.log('FIX4 reverted');
} else {
  console.log('FIX4 not found');
}

fs.writeFileSync('js/agent.js', s);