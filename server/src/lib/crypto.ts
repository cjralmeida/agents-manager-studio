import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

/** AES-256-GCM encryption for secrets stored in the database. Payload: v1:<iv>:<tag>:<ciphertext> (base64). */
export function createSecretBox(keyHex: string) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (64 hex chars)');

  return {
    encrypt(plainText: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      const parts = [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64'));
      return [VERSION, ...parts].join(':');
    },

    decrypt(payload: string): string {
      const [version, iv, tag, encrypted] = payload.split(':');
      if (version !== VERSION || !iv || !tag || !encrypted) {
        throw new Error('Invalid encrypted payload');
      }
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}

/** Last characters of a secret, safe to display (e.g. "…a1b2"). */
export function secretHint(secret: string) {
  return `…${secret.slice(-4)}`;
}
