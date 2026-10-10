/**
 * 设置的导入导出（2026-10-10 加入）：把选中的几类设置（含密钥）打包成 JSON，用密码加密成一个文件。
 * 加密用 age 的密码模式（scrypt），和云端加密是同一套；电脑上也能用 `age -d` 解开看。
 * 这里只管打包和加解密；从 prefs / 密钥存储里收集、导入后应用见 settingsTransfer.ts。
 */
import { Decrypter, Encrypter } from 'age-encryption'

export type PartId = 'ai' | 'sync' | 'place' | 'misc'

export const PARTS: { id: PartId; label: string; desc: string }[] = [
  { id: 'ai', label: 'AI 服务', desc: '服务列表和 API Key、各功能用哪个服务、补充说明、改过的提示词' },
  { id: 'sync', label: '同步与备份', desc: 'OSS、GitHub 的配置和密钥，自动同步的设置，云端加密的密钥' },
  { id: 'place', label: '位置与天气', desc: '自动定位、高德 key、天气服务、默认城市' },
  { id: 'misc', label: '日记与提醒', desc: '写日记提醒、一天从几点开始、每日诗词、节假日、动态效果、自动检查更新' },
]

export interface BundlePart {
  /** 对应 prefs 里的一部分（结构同 prefs） */
  prefs: Record<string, unknown>
  /** 密钥：名字 → 明文 */
  secrets: Record<string, string>
  /** 其他不在 prefs 里的东西（例如云端加密的公钥、一天从几点开始） */
  extra?: Record<string, unknown>
}

export interface SettingsBundle {
  app: 'diary-app'
  kind: 'settings'
  version: 1
  exportedAt: string
  appVersion: string
  parts: Partial<Record<PartId, BundlePart>>
}

const AGE_MAGIC = 'age-encryption.org/'

export function settingsFileName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `diary-settings-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.age`
}

export async function encryptBundle(b: SettingsBundle, passphrase: string, workFactor = 18): Promise<Uint8Array> {
  if (!passphrase) throw new Error('请设置密码')
  const e = new Encrypter()
  e.setPassphrase(passphrase)
  e.setScryptWorkFactor(workFactor)
  return e.encrypt(JSON.stringify(b, null, 2) + '\n')
}

/** 文件看起来是不是加密的设置文件（选错文件时尽早提示，不用先输密码） */
export function looksLikeBundle(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, AGE_MAGIC.length)) === AGE_MAGIC
}

/** 解开并检查格式。密码错抛“密码不对”，选错文件抛“不是浮生记导出的设置文件” */
export async function decryptBundle(bytes: Uint8Array, passphrase: string): Promise<SettingsBundle> {
  if (!looksLikeBundle(bytes)) throw new Error('不是浮生记导出的设置文件')
  const d = new Decrypter()
  d.addPassphrase(passphrase)
  let text: string
  try {
    text = await d.decrypt(bytes, 'text')
  } catch (e) {
    const m = (e as Error).message
    if (/no identity matched|incorrect|failed to decrypt|scrypt|passphrase/i.test(m)) throw new Error('密码不对')
    throw new Error(`文件损坏：${m}`)
  }
  let b: SettingsBundle
  try {
    b = JSON.parse(text) as SettingsBundle
  } catch {
    throw new Error('不是浮生记导出的设置文件')
  }
  if (!b || b.app !== 'diary-app' || b.kind !== 'settings' || typeof b.parts !== 'object' || !b.parts) {
    throw new Error('不是浮生记导出的设置文件')
  }
  // 只留认识的类别，每类的结构也检查一下，免得导入时出错
  const parts: SettingsBundle['parts'] = {}
  for (const { id } of PARTS) {
    const p = b.parts[id]
    if (!p || typeof p !== 'object') continue
    const secrets: Record<string, string> = {}
    if (p.secrets && typeof p.secrets === 'object') {
      for (const [k, v] of Object.entries(p.secrets)) if (typeof v === 'string') secrets[k] = v
    }
    parts[id] = {
      prefs: p.prefs && typeof p.prefs === 'object' ? p.prefs : {},
      secrets,
      extra: p.extra && typeof p.extra === 'object' ? p.extra : undefined,
    }
  }
  return { ...b, parts }
}
