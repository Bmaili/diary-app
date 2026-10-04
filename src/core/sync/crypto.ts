/**
 * 云端加密（每个后端单独开关，默认关闭）。用开放的 age 格式（https://age-encryption.org），
 * 不依赖这个 app 也能解开：电脑上装 age，`age -d -i 身份文件 xxx.md.age`。
 *
 * 密钥结构：
 * - 一把 X25519 身份密钥（AGE-SECRET-KEY-…）。日记都加密给它的公钥，速度快。
 * - 身份密钥本身用你的密码（scrypt）加密，存成云端的 _encryption/identity.age。新手机恢复时输一次密码即可。
 * - 改密码只需重新包一次身份密钥，不用重新加密全部日记。
 * - 文件名和大小不加密：别人能看出哪天写了、写了多长，看不到内容。
 */
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption'
import { sha256Hex } from '../bytes'

/** 云端放密钥说明的目录，里面的文件不加密（identity.age 本身由密码保护） */
export const META_DIR = '_encryption/'
export const META_INFO = `${META_DIR}info.json`
export const META_IDENTITY = `${META_DIR}identity.age`
export const META_README = `${META_DIR}README.md`
export const AGE_EXT = '.age'

export const isMeta = (path: string) => path.startsWith(META_DIR)

/** 本地路径在云端的名字 */
export function remotePathOf(path: string, encrypted: boolean): string {
  return encrypted && !isMeta(path) ? path + AGE_EXT : path
}

/** 云端文件对应的本地路径和形态；说明文件返回 null */
export function localPathOf(remote: string): { path: string; encrypted: boolean } | null {
  if (isMeta(remote)) return null
  return remote.endsWith(AGE_EXT) ? { path: remote.slice(0, -AGE_EXT.length), encrypted: true } : { path: remote, encrypted: false }
}

export interface KeyBundle {
  /** AGE-SECRET-KEY-…，只存在本机加密存储里 */
  identity: string
  /** age1…，公开 */
  recipient: string
  /** 用密码加密后的身份密钥，等同于云端的 identity.age */
  wrapped: Uint8Array
}

export const MIN_PASSPHRASE = 10

export function checkPassphrase(p: string): string | null {
  if (p.length < MIN_PASSPHRASE) return `密码至少 ${MIN_PASSPHRASE} 个字符`
  if (/^(.)\1*$/.test(p)) return '密码太简单'
  return null
}

/** 生成一个约 100 位熵的随机密码，形如 k7mq-3vxe-… */
export function generatePassphrase(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length])
  return [0, 4, 8, 12, 16].map((i) => chars.slice(i, i + 4).join('')).join('-')
}

export async function wrapIdentity(identity: string, passphrase: string, workFactor = 18): Promise<Uint8Array> {
  const e = new Encrypter()
  e.setPassphrase(passphrase)
  e.setScryptWorkFactor(workFactor)
  return e.encrypt(identity + "\n")
}

export async function createKeys(passphrase: string, workFactor = 18): Promise<KeyBundle> {
  const err = checkPassphrase(passphrase)
  if (err) throw new Error(err)
  const identity = await generateX25519Identity()
  return { identity, recipient: await identityToRecipient(identity), wrapped: await wrapIdentity(identity, passphrase, workFactor) }
}

/** 用密码解开云端的 identity.age。密码错时抛出“密码不对” */
export async function unwrapIdentity(wrapped: Uint8Array, passphrase: string): Promise<KeyBundle> {
  const d = new Decrypter()
  d.addPassphrase(passphrase)
  let identity: string
  try {
    identity = (await d.decrypt(wrapped, 'text')).trim()
  } catch (e) {
    const m = (e as Error).message
    if (/no identity matched|incorrect|failed to decrypt/i.test(m)) throw new Error('密码不对')
    throw new Error(`密钥文件损坏：${m}`)
  }
  if (!identity.startsWith('AGE-SECRET-KEY-')) throw new Error('密钥文件内容不对')
  return { identity, recipient: await identityToRecipient(identity), wrapped }
}

export class SyncCrypto {
  constructor(readonly keys: KeyBundle) {}

  async encrypt(bytes: Uint8Array): Promise<Uint8Array> {
    const e = new Encrypter()
    e.addRecipient(this.keys.recipient)
    return e.encrypt(bytes)
  }

  async decrypt(bytes: Uint8Array): Promise<Uint8Array> {
    const d = new Decrypter()
    d.addIdentity(this.keys.identity)
    try {
      return await d.decrypt(bytes)
    } catch (e) {
      throw new Error(`解密失败（可能是用另一把密钥加密的）：${(e as Error).message}`)
    }
  }

  /** 云端 _encryption/ 下的三个说明文件（明文；identity.age 由密码保护） */
  async metaFiles(): Promise<{ path: string; bytes: Uint8Array; hash: string }[]> {
    const enc = new TextEncoder()
    const files: [string, Uint8Array][] = [
      [META_INFO, enc.encode(JSON.stringify({ format: 'age', version: 1, recipient: this.keys.recipient, suffix: AGE_EXT }, null, 2) + '\n')],
      [META_IDENTITY, this.keys.wrapped],
      [META_README, enc.encode(README)],
    ]
    return Promise.all(files.map(async ([path, bytes]) => ({ path, bytes, hash: await sha256Hex(bytes) })))
  }
}

const README = `# 这个文件夹里的日记是加密的

除了 \`_encryption/\` 这个文件夹，其余文件都用 [age](https://age-encryption.org) 加密，文件名后面多了 \`.age\`。
解密后就是普通的 Markdown 日记（格式说明见解密后的 README.md）。

## 不用日记 app，在电脑上解密

1. 安装 age：macOS \`brew install age\`；Windows \`winget install FiloSottile.age\`；Linux 用系统的包管理器。
2. 用你的同步加密密码解出身份密钥：

   \`\`\`
   age -d -o key.txt _encryption/identity.age
   \`\`\`

3. 解密任意一个文件：

   \`\`\`
   age -d -i key.txt entries/2026/2026-10-04.md.age > 2026-10-04.md
   \`\`\`

   批量解密（macOS / Linux）：

   \`\`\`
   find . -name '*.age' ! -path './_encryption/*' -exec sh -c 'age -d -i key.txt "$1" > "\${1%.age}"' _ {} \;
   \`\`\`

用完请删掉 key.txt：有了它就能解开全部日记。
`
