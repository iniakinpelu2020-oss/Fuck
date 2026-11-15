const fs = require('fs');
let s = fs.readFileSync('functions/api/chat.js', 'utf8');

const old = "      attempts[1] = { auth: attempt.auth, model: 'gemini-2.5-flash', reason: 'fallback-503-429-gemini-2.5-flash' };\r\n      if (attempts.length < 2) attempts.length = 2;\r\n      continue;";
const nw = "      // Only inject fallback if no configured fallback already in place, or same model\r\n      if (!attempts[1] || attempts[1].model === attempt.model) {\r\n        attempts[1] = { auth: attempt.auth, model: 'gemini-2.5-flash', reason: 'fallback-503-429-gemini-2.5-flash' };\r\n        if (attempts.length < 2) attempts.length = 2;\r\n      }\r\n      continue;";
if (s.includes(old)) {
  s = s.replace(old, nw);
  console.log('chat.js fix applied');
} else {
  console.log('chat.js pattern not found');
}

fs.writeFileSync('functions/api/chat.js', s);