import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { DiaryRepo, entryPath } from '../src/core/repo'
import { SyncEngine } from '../src/core/sync/engine'
import { authorization, canonicalRequest, OssStore, ossDate, regionOf, type OssConfig } from '../src/core/sync/oss'
import { GitHubStore, type GitHubConfig } from '../src/core/sync/github'
import { previewRemote, restoreFrom } from '../src/core/sync/restore'
import { generateTestEntries } from '../src/core/testData'
import { NodeStore } from './nodeStore'
import { startOssMock, type OssMock } from './mocks/ossServer'
import { startGitHubMock, type GitHubMock } from './mocks/githubServer'

const require = createRequire(import.meta.url)
const signUtils = require('ali-oss/lib/common/signUtils.js')

const OSS_ID = 'LTAI5tTestKeyId'
const OSS_SECRET = 'testSecret/With+Chars='
const BUCKET = 'my-diary'

let oss: OssMock
let gh: GitHubMock
const realFetch = globalThis.fetch

beforeAll(async () => {
  oss = await startOssMock({ bucket: BUCKET, region: 'cn-hangzhou', id: OSS_ID, secret: OSS_SECRET })
  // 把发往 <bucket>.oss-cn-hangzhou.aliyuncs.com 的请求改写到本地模拟服务器（路径式访问）
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const m = /^https:\/\/([^.]+)\.oss-cn-hangzhou\.aliyuncs\.com\/(.*)$/.exec(url)
    return realFetch(m ? `http://127.0.0.1:${oss.port}/${m[1]}/${m[2]}` : url, init)
  })
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await oss.close()
})

const ossCfg = (over: Partial<OssConfig> = {}): OssConfig => ({
  endpoint: 'oss-cn-hangzhou.aliyuncs.com', bucket: BUCKET, prefix: 'diary/',
  accessKeyId: OSS_ID, accessKeySecret: OSS_SECRET, ...over,
})

async function setup() {
  const store = await NodeStore.temp()
  const repo = new DiaryRepo(store)
  await repo.init()
  return { store, repo, engine: new SyncEngine(repo, store) }
}
const write = (repo: DiaryRepo, date: string, body: string) => repo.saveEntry({ meta: { date }, body, extra: [] })

describe('OSS V4 签名', () => {
  it('与阿里云官方 SDK ali-oss 的计算结果逐字节一致', async () => {
    const cases: { method: string; key: string; query: Record<string, string>; ct?: string }[] = [
      { method: 'PUT', key: 'diary/entries/2026/2026-10-04.md', query: {}, ct: 'text/markdown; charset=utf-8' },
      { method: 'GET', key: '', query: { 'list-type': '2', prefix: 'diary/', 'max-keys': '1000', 'continuation-token': 'a b+c/=' }, ct: undefined },
      { method: 'DELETE', key: 'diary/attachments/2026/中文 文件(1).jpg', query: {}, ct: undefined },
    ]
    for (const c of cases) {
      const headers: Record<string, string> = { 'x-oss-content-sha256': 'UNSIGNED-PAYLOAD', 'x-oss-date': ossDate(new Date(Date.UTC(2026, 9, 4, 13, 5, 9))) }
      if (c.ct) headers['content-type'] = c.ct
      const ours = await authorization(ossCfg(), { method: c.method, bucket: BUCKET, key: c.key, query: c.query, headers }, 'cn-hangzhou')
      const official = signUtils.authorizationV4(OSS_ID, OSS_SECRET, 'cn-hangzhou', c.method, { headers, queries: c.query }, BUCKET, c.key || undefined)
      expect(ours).toBe(official)
      expect(canonicalRequest({ method: c.method, bucket: BUCKET, key: c.key, query: c.query, headers }))
        .toBe(signUtils.getCanonicalRequest(c.method, { headers, queries: c.query }, BUCKET, c.key || undefined, []))
    }
  })
  it('从 Endpoint 推出地域', () => {
    expect(regionOf('oss-cn-hangzhou.aliyuncs.com')).toBe('cn-hangzhou')
    expect(regionOf('https://oss-cn-shanghai-internal.aliyuncs.com/')).toBe('cn-shanghai')
    expect(() => regionOf('example.com')).toThrow()
  })
})

describe('同步到阿里云 OSS', () => {
  beforeEach(() => oss.objects.clear())

  it('验收：写一篇后同步，文件出现在 Bucket 中，类型为 text/markdown', async () => {
    const { repo, engine } = await setup()
    await write(repo, '2026-10-04', '今天开始用 OSS 同步。')
    const remote = new OssStore(ossCfg())
    expect(await engine.pending('oss')).toBe(3) // README、format.json、日记
    expect(await engine.sync(remote)).toEqual({ uploaded: 3, deleted: 0 })
    const o = oss.objects.get('diary/entries/2026/2026-10-04.md')!
    expect(o.body.toString()).toContain('今天开始用 OSS 同步。')
    expect(o.type).toBe('text/markdown; charset=utf-8')
    expect(await engine.pending('oss')).toBe(0)
    // 没有变化时再同步，不产生任何请求
    const before = oss.requests.length
    await engine.sync(remote)
    expect(oss.requests.length).toBe(before)
  })

  it('验收：删除一篇日记后，云端副本被删除', async () => {
    const { repo, engine } = await setup()
    await write(repo, '2026-10-03', 'a')
    await write(repo, '2026-10-04', 'b')
    const remote = new OssStore(ossCfg())
    await engine.sync(remote)
    await repo.deleteEntry('2026-10-03')
    expect(await engine.sync(remote)).toEqual({ uploaded: 0, deleted: 1 })
    expect(oss.objects.has('diary/entries/2026/2026-10-03.md')).toBe(false)
    expect(oss.objects.has('diary/entries/2026/2026-10-04.md')).toBe(true)
  })

  it('验收：断网时写的日记，恢复网络后全部同步；已成功的不重传', async () => {
    const { repo, engine } = await setup()
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) await write(repo, d, d)
    const remote = new OssStore(ossCfg())
    oss.failNext(1000)
    await expect(engine.sync(remote)).rejects.toThrow(/500/)
    expect(await engine.pending('oss')).toBe(5)
    oss.failNext(0)
    await engine.sync(remote)
    expect(await engine.pending('oss')).toBe(0)
    expect([...oss.objects.keys()].filter((k) => k.startsWith('diary/entries/'))).toHaveLength(3)
  })

  it('中途失败可以断点续传：已上传的文件写入清单，下次只传剩下的', async () => {
    const { repo, engine } = await setup()
    await generateTestEntries(repo, { count: 40, endDate: '2026-10-04' })
    const remote = new OssStore(ossCfg())
    let n = 0
    // 第 25 个请求起全部失败
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (++n >= 25) return Promise.resolve(new Response('<Error><Code>InternalError</Code></Error>', { status: 500 }))
      const m = /^https:\/\/([^.]+)\.oss-cn-hangzhou\.aliyuncs\.com\/(.*)$/.exec(url)
      return realFetch(m ? `http://127.0.0.1:${oss.port}/${m[1]}/${m[2]}` : url, init)
    })
    await expect(engine.sync(remote)).rejects.toThrow()
    const left = await engine.pending('oss')
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThan(42)
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const m = /^https:\/\/([^.]+)\.oss-cn-hangzhou\.aliyuncs\.com\/(.*)$/.exec(url)
      return realFetch(m ? `http://127.0.0.1:${oss.port}/${m[1]}/${m[2]}` : url, init)
    })
    const before = oss.requests.length
    await engine.sync(remote)
    expect(oss.requests.length - before).toBe(left)
  })

  it('列表超过 1000 个文件时分页读取', async () => {
    for (let i = 0; i < 1203; i++) oss.objects.set(`diary/entries/x/${i}.md`, { body: Buffer.from('x'), type: 'text/plain' })
    expect((await new OssStore(ossCfg()).list()).length).toBe(1203)
  })

  it('错误信息说清楚原因', async () => {
    await expect(new OssStore(ossCfg({ accessKeySecret: 'wrong' })).test()).rejects.toThrow(/Secret 不对/)
    await expect(new OssStore(ossCfg({ bucket: 'nope' })).test()).rejects.toThrow(/Bucket 不存在/)
    await expect(new OssStore(ossCfg()).test()).resolves.toBeUndefined()
  })

  it('同一时刻只跑一个同步任务', async () => {
    const { repo, engine } = await setup()
    await write(repo, '2026-10-04', 'x')
    const remote = new OssStore(ossCfg())
    const [a, b] = await Promise.all([engine.sync(remote), engine.sync(remote)])
    expect(a).toBe(b)
  })
})

describe('同步到 GitHub', () => {
  const TOKEN = 'github_pat_test'
  beforeEach(async () => {
    gh = await startGitHubMock({ owner: 'me', repo: 'diary', token: TOKEN })
  })
  afterEach(() => gh.close())
  const ghCfg = (over: Partial<GitHubConfig> = {}): GitHubConfig => ({
    owner: 'me', repo: 'diary', branch: 'main', token: TOKEN, apiBase: `http://127.0.0.1:${gh.port}`, prefix: '', ...over,
  })

  it('验收：空仓库也能同步；之后每次同步只产生一个 commit', async () => {
    const { repo, engine } = await setup()
    await write(repo, '2026-10-03', '第一篇')
    await write(repo, '2026-10-04', '第二篇')
    const remote = new GitHubStore(ghCfg())
    await engine.sync(remote)
    expect(gh.files().get('entries/2026/2026-10-04.md')!.toString()).toContain('第二篇')
    expect(gh.files().has('README.md')).toBe(true)
    const c1 = gh.commits().length // 初始化 + 一次同步
    expect(c1).toBe(2)

    await write(repo, '2026-10-04', '第二篇，改过')
    await repo.deleteEntry('2026-10-03')
    await write(repo, '2026-10-05', '第三篇')
    expect(await engine.sync(remote)).toEqual({ uploaded: 2, deleted: 1 })
    expect(gh.commits().length).toBe(c1 + 1)
    expect(gh.commits().at(-1)!.message).toMatch(/^sync: \d{4}-\d{2}-\d{2} \(3 files\)$/)
    expect(gh.files().has('entries/2026/2026-10-03.md')).toBe(false)
    expect(await engine.pending('github')).toBe(0)
  })

  it('Token 错误、仓库不存在时给出明确提示', async () => {
    await expect(new GitHubStore(ghCfg({ token: 'bad' })).test()).rejects.toThrow(/Token 无效/)
    await expect(new GitHubStore(ghCfg({ repo: 'nope' })).test()).rejects.toThrow(/仓库不存在/)
  })

  it('验收：GitHub 失败时 OSS 照常完成', async () => {
    oss.objects.clear()
    const { repo, engine } = await setup()
    await write(repo, '2026-10-04', 'x')
    const r = await engine.syncAll([new OssStore(ossCfg()), new GitHubStore(ghCfg({ token: 'bad' }))])
    expect(r.oss.ok).toBe(true)
    expect(r.github.ok).toBe(false)
    expect(oss.objects.has('diary/entries/2026/2026-10-04.md')).toBe(true)
    expect(await engine.pending('github')).toBe(3)
  })
})

describe('从云端恢复（规格 6.6）', () => {
  const TOKEN = 'github_pat_test'
  beforeEach(async () => {
    oss.objects.clear()
    gh = await startGitHubMock({ owner: 'me', repo: 'diary', token: TOKEN })
  })
  afterEach(() => gh.close())
  const ghCfg = (): GitHubConfig => ({ owner: 'me', repo: 'diary', branch: 'main', token: TOKEN, apiBase: `http://127.0.0.1:${gh.port}`, prefix: '' })

  async function snapshot(store: NodeStore, repo: DiaryRepo) {
    const out = new Map<string, string>()
    for (const p of await repo.listAllFiles()) out.set(p, (await store.readBase64(p))!)
    return out
  }

  for (const kind of ['oss', 'github', 'github-blobs'] as const) {
    it(`验收：清除 app 数据后从 ${kind} 恢复，文件逐字节一致，且不会全量重新上传`, async () => {
      const a = await setup()
      await generateTestEntries(a.repo, { count: 60, endDate: '2026-10-04' })
      await a.store.writeBase64('diary/attachments/2026/2026-10-04_1.jpg', Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10, 0x80]).toString('base64'))
      const remoteA = kind === 'oss' ? new OssStore(ossCfg()) : new GitHubStore(ghCfg())
      await a.engine.sync(remoteA)
      const original = await snapshot(a.store, a.repo)

      // 新手机：全新的数据目录
      const b = await setup()
      if (kind === 'github-blobs') gh.failZipball = true
      const remoteB = kind === 'oss' ? new OssStore(ossCfg()) : new GitHubStore(ghCfg())
      const pv = await previewRemote(remoteB)
      expect(pv.entries).toBe(60)
      expect(pv.latest).toBe('2026-10-04')
      const r = await restoreFrom(remoteB, b.store, b.engine)
      expect(r.replacedAll).toBe(true)
      expect(await snapshot(b.store, b.repo)).toEqual(original)
      expect(await b.engine.pending(remoteB.id)).toBe(0)
    })
  }

  it('本地已有日记时：只补入本地没有的，同名不同内容的保留本地并列出', async () => {
    const a = await setup()
    await write(a.repo, '2026-10-01', '云端版本 1')
    await write(a.repo, '2026-10-02', '云端版本 2')
    await a.engine.sync(new OssStore(ossCfg()))

    const b = await setup()
    await write(b.repo, '2026-10-02', '手机上的版本 2')
    await write(b.repo, '2026-10-03', '手机上的 3')
    const r = await restoreFrom(new OssStore(ossCfg()), b.store, b.engine)
    expect(r.replacedAll).toBe(false)
    expect(r.restored).toEqual(['entries/2026/2026-10-01.md'])
    expect(r.skipped).toEqual(['entries/2026/2026-10-02.md'])
    expect(await b.store.readText(entryPath('2026-10-02'))).toContain('手机上的版本 2')
    // 本地版本、本地独有的文件会在下次同步时上传
    const plan = await b.engine.plan('oss')
    expect(plan.uploads.sort()).toEqual(['entries/2026/2026-10-02.md', 'entries/2026/2026-10-03.md'])
  })

  it('云端不是日记文件夹时拒绝恢复', async () => {
    oss.objects.set('diary/random.txt', { body: Buffer.from('x'), type: 'text/plain' })
    const b = await setup()
    await expect(restoreFrom(new OssStore(ossCfg()), b.store, b.engine)).rejects.toThrow(/format.json/)
  })
})
