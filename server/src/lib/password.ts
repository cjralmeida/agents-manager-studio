import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** scrypt cost (N=2^15) and block size: ~50 ms per check, enough against offline guessing for a local tool. */
const COST = 32_768;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, cost: number, blockSize: number, parallelism: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N: cost, r: blockSize, p: parallelism, maxmem: MAX_MEMORY }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** "scrypt$N$r$p$salt$hash" (base64url), so the cost can change without breaking stored hashes. */
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST, BLOCK_SIZE, PARALLELISM);
  return ['scrypt', COST, BLOCK_SIZE, PARALLELISM, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, cost, blockSize, parallelism, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await derive(password, Buffer.from(salt, 'base64url'), Number(cost), Number(blockSize), Number(parallelism));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Random password for new users (letters and digits, no look-alikes). */
export function generatePassword(length = 20) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(length * 2);
  let password = '';
  for (const byte of bytes) {
    // Rejection sampling keeps every character equally likely.
    if (byte < 256 - (256 % alphabet.length)) password += alphabet[byte % alphabet.length];
    if (password.length === length) break;
  }
  return password;
}

/** Rules for passwords chosen by people; returns the problem in Portuguese, or null. */
export function passwordProblem(password: string) {
  if (password.length < 10) return 'Use pelo menos 10 caracteres.';
  if (password.length > 200) return 'Use no máximo 200 caracteres.';
  return null;
}
