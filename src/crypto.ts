import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function hashSecret(secret: string): string { return createHash('sha256').update(secret).digest('hex'); }
export function newSecret(prefix: string): string { return `${prefix}_${randomBytes(32).toString('base64url')}`; }
export function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function encrypt(plain: string, keyHex: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), nonce);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64url');
}
export function decrypt(ciphertext: string, keyHex: string): string {
  const bytes = Buffer.from(ciphertext, 'base64url');
  if (bytes.length < 29) throw new Error('Invalid encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
