#!/usr/bin/env node
/**
 * Generate a bcrypt hash for ADMIN_PASSWORD_HASH.
 *
 * Usage:
 *   node scripts/hash-admin-password.js "your-password-here"
 *
 * Copy the output (the full $2a$... string) into Railway as ADMIN_PASSWORD_HASH.
 * The password itself never leaves your machine.
 */

import bcrypt from 'bcryptjs';

const password = process.argv[2];

if (!password) {
  console.error('Usage: node scripts/hash-admin-password.js "your-password"');
  console.error('');
  console.error('Tip: wrap the password in quotes so your shell does not eat special characters.');
  process.exit(1);
}

if (password.length < 12) {
  console.error('Password must be at least 12 characters. This is admin access — make it strong.');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);

console.log('');
console.log('Password hash generated.');
console.log('');
console.log('Set this as ADMIN_PASSWORD_HASH in Railway:');
console.log('');
console.log(hash);
console.log('');
console.log('Also set ADMIN_EMAIL to the email you want to log in with.');
