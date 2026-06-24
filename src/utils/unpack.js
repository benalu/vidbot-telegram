// src/utils/unpack.js
// Unpack P.A.C.K.E.R eval obfuscation — dipakai oleh spider-movs dan provider lain.

'use strict';

/**
 * Unpack eval(function(p,a,c,k,e,d){...}) obfuscation.
 * Return string hasil unpack, atau null kalau bukan P.A.C.K.E.R.
 */
function unpackEval(code) {
  const re = /eval\(function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)[\s\S]*?\}\s*\(\s*(['"].*?['"])\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"].*?['"])\.split\(['"]\|['"]\)/;
  const m = code.match(re);
  if (!m) return null;
  try {
    let p  = m[1].slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"');
    const a = parseInt(m[2], 10);
    let c   = parseInt(m[3], 10);
    const k = m[4].slice(1, -1).split('|');
    const e = (n) => (n < a ? '' : e(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    const d = {};
    while (c--) d[e(c)] = k[c] || e(c);
    return p.replace(/\b\w+\b/g, w => d[w] || w);
  } catch {
    return null;
  }
}

module.exports = { unpackEval };