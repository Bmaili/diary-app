import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiaryRepo } from '../src/core/repo'
import { SyncEngine } from '../src/core/sync/engine'
import { OssStore, type OssConfig } from '../src/core/sync/oss'
import { GitHubStore, type GitHubConfig } from '../src/core/sync/github'
import { previewRemote, restoreFrom, unlockRemote } from '../src/core/sync/restore'
import {
  SyncCrypto, createKeys, checkPassphrase, generatePassphrase, localPathOf, remotePathOf, unwrapIdentity, wrapIdentity,
} from '../src/core/sync/crypto'
import { generateTestEntries } from '../src/core/testData'
import { NodeStore } from './nodeStore'
import { startOssMock, type OssMock } from './mocks/ossServer'
import { startGitHubMock, type GitHubMock } from './mocks/githubServer'

const OSS_ID = 'LTAI5tCryptoTest'
const OSS_SECRET = 'cryptoSecret'
const BUCKET = 'crypto-diary'
const PASS = 'orbit-nebula-42'
const WF = 10 // 测试里用很小的 scrypt 强度，正式是 18

let oss: OssMock
let gh: GitHubMock
const realFetch = globalThis.fetch

beforeAll(async () => {
  oss = await startOssMock({ bucket: BUCKET, region: 'cn-hangzhou', id: OSS_ID, secret: OSS_SECRET })
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const m = /^https:\/\/([^.]+)\.oss-cn-hangzhou\.aliyuncs\.com\/(.*)$/.exec(url)
    return realFetch(m ? `http://127.0.0.1:${oss.port}/${m[1]}/${m[2]}` : url, init)
  })
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await oss.close()
})
beforeEach(async () => {
  oss.objects.clear()
  gh = await startGitHubMock({ owner: 'me', repo: 'diary', token: 'tok' })
})
afterEach(() => gh.close())

const ossCfg = (): OssConfig => ({ endpoint: 'oss-cn-hangzhou.aliyuncs.com', bucket: BUCKET, prefix: 'diary/', accessKeyId: OSS_ID, accessKeySecret: OSS_SECRET })
const ghCfg = (): GitHubConfig => ({ owner: 'me', repo: 'diary', branch: 'main', token: 'tok', apiBase: `http://127.0.0.1:${gh.port}`, prefix: '' })

async function setup() {
  const store = await NodeStore.temp()
  const repo = new DiaryRepo(store)
  await repo.init()
  return { store, repo, engine: new SyncEngine(repo, store) }
}
const write = (repo: DiaryRepo, date: string, body: string) => repo.saveEntry({ meta: { date }, body, extra: [] })
const ossKeys = () => [...oss.objects.keys()].map((k) => k.slice('diary/'.length)).sort()

async function snapshot(store: NodeStore, repo: DiaryRepo) {
  const out = new Map<string, string>()
  for (const p of await repo.listAllFiles()) out.set(p, (await store.readBase64(p))!)
  return out
}

describe('核对云端', () => {
  it('OSS：云端被删或被改的文件，核对后补传；不核对时察觉不到', async () => {
    const { repo, engine } = await setup()
    await write(repo, '2026-10-02', '第一篇')
    await write(repo, '2026-10-03', '第二篇')
    await write(repo, '2026-10-04', '第三篇')
    const remote = new OssStore(ossCfg())
    await engine.sync(remote)
    oss.objects.delete('diary/entries/2026/2026-10-02.md')
    oss.objects.get('diary/entries/2026/2026-10-03.md')!.body = Buffer.from('被别人改过的内容，长度不一样')
    // 这就是之前的漏洞：清单以为都传过了
    expect(await engine.pending('oss')).toBe(0)

    const r = await engine.reconcile(remote)
    expect(r.missing).toEqual(['entries/2026/2026-10-02.md'])
    expect(r.changed).toEqual(['entries/2026/2026-10-03.md'])
    expect(await engine.pending('oss')).toBe(2)
    await engine.sync(remote)
    expect(oss.objects.get('diary/entries/2026/2026-10-02.md')!.body.toString()).toContain('第一篇')
    expect(oss.objects.get('diary/entries/2026/2026-10-03.md')!.body.toString()).toContain('第二篇')
    expect((await engine.reconcile(remote)).missing).toEqual([])
    expect((await engine.readState('oss')).lastCheck).toBeGreaterThan(0)
  })

  it('OSS：整个前缀被清空后，核对一次就全部重传', async () => {
    const { repo, engine } = await setup()
    await generateTestEntries(repo, { count: 20, endDate: '2026-10-04' })
    const remote = new OssStore(ossCfg())
    await engine.sync(remote)
    const n = oss.objects.size
    oss.objects.clear()
    const r = await engine.reconcile(remote)
    expect(r.missing.length).toBe(n)
    await engine.sync(remote)
    expect(oss.objects.size).toBe(n)
  })

  it('GitHub：仓库里删掉的文件，核对后补传', async () => {
    const { repo, engine } = await setup()
    await write(repo, '2026-10-03', 'A')
    await write(repo, '2026-10-04', 'B')
    const remote = new GitHubStore(ghCfg())
    await engine.sync(remote)
    // 在别处（网页上）删掉一篇
    await new GitHubStore(ghCfg()).apply([], ['entries/2026/2026-10-03.md'], async () => {})
    expect(gh.files().has('entries/2026/2026-10-03.md')).toBe(false)
    const r = await engine.reconcile(remote)
    expect(r.missing).toEqual(['entries/2026/2026-10-03.md'])
    await engine.sync(remote)
    expect(gh.files().get('entries/2026/2026-10-03.md')!.toString()).toContain('A')
  })
})

describe('加密工具', () => {
  it('路径映射', () => {
    expect(remotePathOf('entries/2026/2026-10-04.md', true)).toBe('entries/2026/2026-10-04.md.age')
    expect(remotePathOf('entries/2026/2026-10-04.md', false)).toBe('entries/2026/2026-10-04.md')
    expect(remotePathOf('_encryption/identity.age', true)).toBe('_encryption/identity.age')
    expect(localPathOf('attachments/2026/a.jpg.age')).toEqual({ path: 'attachments/2026/a.jpg', encrypted: true })
    expect(localPathOf('_encryption/info.json')).toBeNull()
  })
  it('密码检查与生成', () => {
    expect(checkPassphrase('short')).toMatch(/至少/)
    expect(checkPassphrase('aaaaaaaaaaaa')).toMatch(/简单/)
    expect(checkPassphrase(PASS)).toBeNull()
    const g = generatePassphrase()
    expect(g).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){4}$/)
    expect(generatePassphrase()).not.toBe(g)
  })
  it('身份密钥：密码包装与解开；密码错给出明确提示；改密码不换密钥', async () => {
    const k = await createKeys(PASS, WF)
    expect(k.identity).toMatch(/^AGE-SECRET-KEY-1/)
    expect(k.recipient).toMatch(/^age1/)
    expect((await unwrapIdentity(k.wrapped, PASS)).identity).toBe(k.identity)
    await expect(unwrapIdentity(k.wrapped, 'wrong-password')).rejects.toThrow('密码不对')
    const re = await wrapIdentity(k.identity, 'another-pass-99', WF)
    const k2 = await unwrapIdentity(re, 'another-pass-99')
    expect(k2.recipient).toBe(k.recipient)
  })
  it('二进制往返；加密结果每次不同', async () => {
    const c = new SyncCrypto(await createKeys(PASS, WF))
    const data = new Uint8Array(200_000).map((_, i) => (i * 7) % 256)
    const a = await c.encrypt(data)
    const b = await c.encrypt(data)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
    expect(Buffer.from(await c.decrypt(a)).equals(Buffer.from(data))).toBe(true)
    const other = new SyncCrypto(await createKeys('different-pass-1', WF))
    await expect(other.decrypt(a)).rejects.toThrow(/解密失败/)
  })
  it.skipIf(!existsSync('/usr/bin/age'))('电脑上的 age 命令能解开 app 加密的文件', async () => {
    const k = await createKeys(PASS, WF)
    const c = new SyncCrypto(k)
    const dir = mkdtempSync(join(tmpdir(), 'age-'))
    writeFileSync(join(dir, 'key.txt'), k.identity + '\n')
    writeFileSync(join(dir, 'x.md.age'), await c.encrypt(new TextEncoder().encode('---\ndate: 2026-10-04\n---\n今天看到了木星。\n')))
    const out = execFileSync('/usr/bin/age', ['-d', '-i', join(dir, 'key.txt'), join(dir, 'x.md.age')]).toString()
    expect(out).toContain('今天看到了木星。')
  })
})

describe('加密同步', () => {
  it('OSS：打开加密后全部改成 .age，旧明文被清理；关闭后改回明文', async () => {
    const { store, repo, engine } = await setup()
    await write(repo, '2026-10-03', '明文时期写的')
    await store.writeBase64('diary/attachments/2026/2026-10-03_1.jpg', Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString('base64'))
    const remote = new OssStore(ossCfg())
    await engine.sync(remote)
    expect(ossKeys()).toContain('entries/2026/2026-10-03.md')

    const crypto = new SyncCrypto(await createKeys(PASS, WF))
    expect(await engine.pending('oss', { crypto })).toBeGreaterThan(3) // 形态变了，全部待传
    await engine.sync(remote, undefined, { crypto })
    const keys = ossKeys()
    expect(keys).toContain('entries/2026/2026-10-03.md.age')
    expect(keys).toContain('attachments/2026/2026-10-03_1.jpg.age')
    expect(keys).toContain('_encryption/identity.age')
    expect(keys).toContain('_encryption/info.json')
    expect(keys.filter((k) => !k.startsWith('_encryption/') && !k.endsWith('.age'))).toEqual([])
    const enc = oss.objects.get('diary/entries/2026/2026-10-03.md.age')!.body
    expect(enc.toString('latin1')).toMatch(/^age-encryption\.org\/v1/)
    expect(enc.toString()).not.toContain('明文时期')
    expect(new TextDecoder().decode(await crypto.decrypt(enc))).toContain('明文时期写的')
    expect(await engine.pending('oss', { crypto })).toBe(0)

    // 之后的修改照常增量
    await write(repo, '2026-10-04', '加密后写的')
    expect(await engine.sync(remote, undefined, { crypto })).toEqual({ uploaded: 1, deleted: 0 })
    // 核对云端在加密时也能用（只看文件在不在）
    oss.objects.delete('diary/entries/2026/2026-10-04.md.age')
    expect((await engine.reconcile(remote, { crypto })).missing).toEqual(['entries/2026/2026-10-04.md'])
    await engine.sync(remote, undefined, { crypto })
    expect(oss.objects.has('diary/entries/2026/2026-10-04.md.age')).toBe(true)

    // 关闭加密
    await engine.sync(remote)
    const plain = ossKeys()
    expect(plain.filter((k) => k.endsWith('.age') || k.startsWith('_encryption/'))).toEqual([])
    expect(oss.objects.get('diary/entries/2026/2026-10-04.md')!.body.toString()).toContain('加密后写的')
  })

  it('改密码只重传密钥文件', async () => {
    const { repo, engine } = await setup()
    await generateTestEntries(repo, { count: 5, endDate: '2026-10-04' })
    const keys = await createKeys(PASS, WF)
    const remote = new OssStore(ossCfg())
    await engine.sync(remote, undefined, { crypto: new SyncCrypto(keys) })
    const rewrapped = { ...keys, wrapped: await wrapIdentity(keys.identity, 'new-pass-2026', WF) }
    const plan = await engine.plan('oss', { crypto: new SyncCrypto(rewrapped) })
    expect(plan.uploads).toEqual(['_encryption/identity.age'])
  })

  it('GitHub：加密同步仍是一次一个 commit', async () => {
    const { repo, engine } = await setup()
    await write(repo, '2026-10-04', '秘密')
    const crypto = new SyncCrypto(await createKeys(PASS, WF))
    const remote = new GitHubStore(ghCfg())
    await engine.sync(remote, undefined, { crypto })
    const c = gh.commits().length
    await write(repo, '2026-10-05', '又一个秘密')
    await engine.sync(remote, undefined, { crypto })
    expect(gh.commits().length).toBe(c + 1)
    expect(gh.files().has('entries/2026/2026-10-05.md.age')).toBe(true)
    expect([...gh.files().keys()].some((p) => p.endsWith('.md') && p.startsWith('entries/'))).toBe(false)
  })

  for (const kind of ['oss', 'github'] as const) {
    it(`${kind}：新手机输密码后恢复，逐字节一致，且不会全量重传`, async () => {
      const a = await setup()
      await generateTestEntries(a.repo, { count: 30, endDate: '2026-10-04' })
      await a.store.writeBase64('diary/attachments/2026/2026-10-04_1.jpg', Buffer.from([0xff, 0xd8, 0xff, 9, 8, 7]).toString('base64'))
      const keys = await createKeys(PASS, WF)
      const remoteA = kind === 'oss' ? new OssStore(ossCfg()) : new GitHubStore(ghCfg())
      await a.engine.sync(remoteA, undefined, { crypto: new SyncCrypto(keys) })
      const original = await snapshot(a.store, a.repo)

      const b = await setup()
      const remoteB = kind === 'oss' ? new OssStore(ossCfg()) : new GitHubStore(ghCfg())
      const pv = await previewRemote(remoteB)
      expect(pv.encrypted).toBe(true)
      expect(pv.recipient).toBe(keys.recipient)
      expect(pv.entries).toBe(30)
      expect(pv.hasFormat).toBe(true)
      await expect(restoreFrom(remoteB, b.store, b.engine)).rejects.toThrow(/加密/)
      await expect(unlockRemote(remoteB, 'not-the-password')).rejects.toThrow('密码不对')
      const unlocked = await unlockRemote(remoteB, PASS)
      expect(unlocked.identity).toBe(keys.identity)
      const crypto = new SyncCrypto(unlocked)
      const r = await restoreFrom(remoteB, b.store, b.engine, undefined, crypto)
      expect(r.replacedAll).toBe(true)
      expect(await snapshot(b.store, b.repo)).toEqual(original)
      expect(await b.engine.pending(remoteB.id, { crypto })).toBe(0)
    })
  }
})
