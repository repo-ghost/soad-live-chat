#!/usr/bin/env node
/**
 * Generates the two credential digests used by the login gate in index.html.
 *
 *   node tools/make-login.js live 5967
 *
 * Paste the printed lines into the AUTH block in index.html, replacing the
 * existing user/pass values.
 *
 * NOTE: a static site cannot protect a password. This just keeps it from
 * sitting in the page as plain text. For real access control, use Firebase
 * Auth (`auth != null` in your rules) — see README §8.
 */
import { createHash } from 'node:crypto';

/** Must stay byte-identical to digest() in index.html. */
function digest(str) {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
    h2 = (((h2 << 5) + h2) + c) >>> 0;
  }
  return (h1 >>> 0).toString(36) + '-' + (h2 >>> 0).toString(36);
}

const [user, pass] = process.argv.slice(2);

if (!user || !pass) {
  console.error('Usage: node tools/make-login.js <username> <password>');
  process.exit(1);
}

console.log('\nPaste these into the AUTH block in index.html:\n');
console.log(`    user: "${digest(user.trim().toLowerCase())}",`);
console.log(`    pass: "${digest(pass)}",`);
console.log('\n(usernames are matched case-insensitively, passwords are case-sensitive)\n');

console.log('Reference — plain SHA-256, if you prefer using that instead:');
console.log('  user:', createHash('sha256').update(user.trim().toLowerCase()).digest('hex'));
console.log('  pass:', createHash('sha256').update(pass).digest('hex'));
console.log('');
