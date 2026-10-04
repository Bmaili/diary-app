/**
 * 应用锁 PIN 的哈希（PBKDF2-SHA256）。只存盐和哈希，不存 PIN 本身。
 * 注意：应用锁是防“别人拿起手机翻看”的门帘，不是加密——日记文件本身仍是明文 Markdown。
 */
import { fromBase64, toBase64 } from './bytes'

export interface PinRecord {
  salt: string
  hash: string
  iter: number
  /** PIN 位数，输满后自动校验 */
  len: number
}

const ITER = 150_000

async function derive(pin: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: iter }, key, 256)
  return new Uint8Array(bits)
}

export function validPin(pin: string): boolean {
  return /^\d{4,8}$/.test(pin)
}

export async function hashPin(pin: string, iter = ITER): Promise<PinRecord> {
  if (!validPin(pin)) throw new Error('PIN 需要 4 到 8 位数字')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return { salt: toBase64(salt), hash: toBase64(await derive(pin, salt, iter)), iter, len: pin.length }
}

export async function verifyPin(pin: string, rec: PinRecord): Promise<boolean> {
  if (pin.length !== rec.len) return false
  const got = await derive(pin, fromBase64(rec.salt), rec.iter)
  const want = fromBase64(rec.hash)
  if (got.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i]
  return diff === 0
}

/** 连续输错后的等待秒数：前 4 次不限制，之后 30 秒起翻倍，最多 15 分钟 */
export function lockoutSeconds(failures: number): number {
  if (failures < 5) return 0
  return Math.min(30 * 2 ** (failures - 5), 900)
}
