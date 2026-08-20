/**
 * AES-256-GCM 加解密：Provider API key 落库格式为
 * `base64url(iv).base64url(tag).base64url(ciphertext)`。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** 将 64 位 hex 主密钥解析为 32 字节 Buffer。 */
export function parseAesMasterKey(hexKey: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error('AES_MASTER_KEY 必须是 64 位十六进制');
  }
  return Buffer.from(hexKey, 'hex');
}

/** 加密明文密钥。 */
export function encryptSecret(plain: string, masterKeyHex: string): string {
  const key = parseAesMasterKey(masterKeyHex);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  if (tag.length !== AUTH_TAG_LENGTH) {
    throw new Error('AES-GCM auth tag 长度异常');
  }
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

/** 解密落库密文。格式错误或鉴权失败时抛错。 */
export function decryptSecret(payload: string, masterKeyHex: string): string {
  const parts = payload.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error('密文格式无效');
  }
  const [ivPart, tagPart, dataPart] = parts as [string, string, string];
  const key = parseAesMasterKey(masterKeyHex);
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const data = Buffer.from(dataPart, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}
