/**
 * 密钥加密存储（规格第 8 节）。
 * 用 WebCrypto 生成一把“不可导出”的 AES-GCM 密钥，存在 WebView 的 IndexedDB 里（app 私有目录）；
 * 各种 AccessKey、Token、API Key 用它加密后再存进 Preferences。JS 代码只能用这把钥匙加解密，读不出钥匙本身。
 * 这比 Android Keystore 弱一档（没有硬件保护），但不需要额外的原生插件；密钥永不写入 diary/，也不同步。
 */
import { Preferences } from '@capacitor/preferences'
import { fromBase64, toBase64 } from '../core/bytes'

const DB = 'diary-secrets'
const STORE = 'keys'
const PREFIX = 'secret.'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

let keyPromise: Promise<CryptoKey> | null = null

function masterKey(): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    const db = await openDb()
    const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const r = db.transaction(STORE).objectStore(STORE).get('main')
      r.onsuccess = () => resolve(r.result as CryptoKey | undefined)
      r.onerror = () => reject(r.error)
    })
    if (existing) return existing
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(key, 'main')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    return key
  })()
  return keyPromise
}

export async function setSecret(name: string, value: string): Promise<void> {
  if (!value) {
    await Preferences.remove({ key: PREFIX + name })
    return
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await masterKey(), new TextEncoder().encode(value)))
  const packed = new Uint8Array(iv.length + ct.length)
  packed.set(iv)
  packed.set(ct, iv.length)
  await Preferences.set({ key: PREFIX + name, value: toBase64(packed) })
}

/** 取不到（没设置过，或密钥库被清空导致无法解密）时返回空串 */
export async function getSecret(name: string): Promise<string> {
  const v = (await Preferences.get({ key: PREFIX + name })).value
  if (!v) return ''
  try {
    const packed = fromBase64(v)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, await masterKey(), packed.slice(12))
    return new TextDecoder().decode(pt)
  } catch {
    return ''
  }
}

export async function hasSecret(name: string): Promise<boolean> {
  return !!(await getSecret(name))
}
