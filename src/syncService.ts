/**
 * 同步调度（规格 6.4）。不依赖后台定时任务（ColorOS / OriginOS 会杀后台）：
 * - 离开编辑页、打开 app、从后台回到前台时，若开着自动同步且有待同步，就立即同步；
 * - 失败后在 app 开着的期间按 30 秒、1、2、5、10 分钟退避重试；
 * - “立即同步”随时可点，忽略“仅 Wi-Fi”。
 */
import { reactive } from 'vue'
import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { Network } from '@capacitor/network'
import { diaryChanged, onDiaryChanged, onStarted, reloadIndex, repo, store } from './app'
import { prefs } from './prefs'
import { getSecret, setSecret } from './platform/secrets'
import { SyncEngine, type CheckResult, type SyncOpts } from './core/sync/engine'
import { SyncCrypto, createKeys, wrapIdentity, type KeyBundle } from './core/sync/crypto'
import { fromBase64, toBase64 } from './core/bytes'
import { OssStore } from './core/sync/oss'
import { GitHubStore } from './core/sync/github'
import type { RemoteStore } from './core/sync/remote'
import { previewRemote, restoreFrom, unlockRemote, type RestorePreview, type RestoreResult } from './core/sync/restore'

export type BackendId = 'oss' | 'github'
export const BACKENDS: { id: BackendId; label: string }[] = [
  { id: 'oss', label: '阿里云 OSS' },
  { id: 'github', label: 'GitHub' },
]

interface BackendState {
  status: 'off' | 'idle' | 'syncing' | 'ok' | 'error'
  pending: number
  lastOk: number | null
  error: string
  progress: { done: number; total: number } | null
  nextRetry: number | null
  check: { running: boolean; at: number | null; result: CheckResult | null; error: string }
}

const blank = (): BackendState => ({
  status: 'off', pending: 0, lastOk: null, error: '', progress: null, nextRetry: null,
  check: { running: false, at: null, result: null, error: '' },
})
export const syncState = reactive<Record<BackendId, BackendState>>({ oss: blank(), github: blank() })

export const engine = new SyncEngine(repo, store)

export function enabled(): BackendId[] {
  return BACKENDS.map((b) => b.id).filter((id) => prefs.sync[id].enabled)
}

export async function buildRemote(id: BackendId): Promise<RemoteStore> {
  if (id === 'oss') {
    const c = prefs.sync.oss
    return new OssStore({ ...c, accessKeySecret: await getSecret('oss.secret') })
  }
  const c = prefs.sync.github
  return new GitHubStore({ ...c, token: await getSecret('github.token') })
}

// ---------- 加密密钥 ----------
// 身份密钥（AGE-SECRET-KEY-…）存在加密存储里；公钥和“用密码包起来的身份密钥”存在 sync/keys.json（本身由密码保护）。

const KEYS_FILE = 'sync/keys.json'
const IDENTITY_SECRET = 'sync.identity'
let keysCache: KeyBundle | null | undefined

export async function loadKeys(): Promise<KeyBundle | null> {
  if (keysCache !== undefined) return keysCache
  try {
    const meta = JSON.parse((await store.readText(KEYS_FILE)) ?? 'null') as { recipient: string; wrapped: string } | null
    const identity = await getSecret(IDENTITY_SECRET)
    keysCache = meta && identity ? { identity, recipient: meta.recipient, wrapped: fromBase64(meta.wrapped) } : null
  } catch {
    keysCache = null
  }
  return keysCache
}

export async function saveKeys(k: KeyBundle): Promise<void> {
  await setSecret(IDENTITY_SECRET, k.identity)
  await store.mkdirp('sync')
  await store.writeText(KEYS_FILE, JSON.stringify({ recipient: k.recipient, wrapped: toBase64(k.wrapped) }))
  keysCache = k
  encState.hasKeys = true
}

export const encState = reactive({ hasKeys: false })

/** 第一次设置加密密码：生成密钥 */
export async function setupEncryption(passphrase: string): Promise<void> {
  await saveKeys(await createKeys(passphrase))
}

/** 改密码：只重新包装身份密钥，日记不用重新加密；下次同步只传 _encryption/identity.age */
export async function changePassphrase(passphrase: string): Promise<void> {
  const k = await loadKeys()
  if (!k) throw new Error('还没有设置加密')
  await saveKeys({ ...k, wrapped: await wrapIdentity(k.identity, passphrase) })
  await refreshPending()
}

/** 本机密钥丢了（或换了手机）但云端是加密的：用密码从云端找回 */
export async function recoverKeys(id: BackendId, passphrase: string): Promise<void> {
  await saveKeys(await unlockRemote(await buildRemote(id), passphrase))
}

async function optsFor(id: BackendId): Promise<SyncOpts> {
  if (!prefs.sync[id].encrypt) return { crypto: null }
  const k = await loadKeys()
  if (!k) throw new Error('找不到加密密钥。请到“同步与备份 → 加密密码”里输入密码找回')
  return { crypto: new SyncCrypto(k) }
}

export async function refreshPending() {
  encState.hasKeys = !!(await loadKeys())
  for (const b of BACKENDS) {
    const s = syncState[b.id]
    if (!prefs.sync[b.id].enabled) {
      Object.assign(s, blank())
      continue
    }
    if (s.status === 'off') s.status = 'idle'
    try {
      s.pending = await engine.pending(b.id, await optsFor(b.id))
    } catch {
      /* 缺密钥，同步时会报错说明 */
    }
    const st = await engine.readState(b.id)
    if (!s.check.running) Object.assign(s.check, { at: st.lastCheck ?? null, result: st.lastCheckResult ?? null })
  }
}

/** 汇总给首页图标用 */
export function overall(): { kind: 'off' | 'syncing' | 'error' | 'pending' | 'ok'; pending: number } {
  const on = enabled()
  if (!on.length) return { kind: 'off', pending: 0 }
  const states = on.map((id) => syncState[id])
  const pending = Math.max(...states.map((s) => s.pending))
  if (states.some((s) => s.status === 'syncing')) return { kind: 'syncing', pending }
  if (states.some((s) => s.status === 'error')) return { kind: 'error', pending }
  return { kind: pending ? 'pending' : 'ok', pending }
}

const RETRY = [30, 60, 120, 300, 600].map((s) => s * 1000)
const attempts: Record<BackendId, number> = { oss: 0, github: 0 }
const timers: Partial<Record<BackendId, ReturnType<typeof setTimeout>>> = {}

async function onWifiOrManual(manual: boolean): Promise<boolean> {
  if (manual || !prefs.sync.wifiOnly) return true
  try {
    return (await Network.getStatus()).connectionType === 'wifi'
  } catch {
    return true
  }
}

async function runOne(id: BackendId): Promise<void> {
  const s = syncState[id]
  if (engine.isBusy(id)) return
  clearTimeout(timers[id])
  s.nextRetry = null
  s.status = 'syncing'
  s.error = ''
  s.progress = null
  try {
    const remote = await buildRemote(id)
    await engine.sync(remote, (done, total) => (s.progress = { done, total }), await optsFor(id))
    s.status = 'ok'
    s.lastOk = Date.now()
    attempts[id] = 0
  } catch (e) {
    s.status = 'error'
    s.error = (e as Error).message
    const delay = RETRY[Math.min(attempts[id], RETRY.length - 1)]
    attempts[id]++
    s.nextRetry = Date.now() + delay
    timers[id] = setTimeout(() => void syncNow(false, [id]), delay)
  } finally {
    s.progress = null
    s.pending = await optsFor(id).then((o) => engine.pending(id, o)).catch(() => s.pending)
  }
}

/** manual=true 时忽略“仅 Wi-Fi”和“自动同步”开关 */
export async function syncNow(manual = true, only?: BackendId[]): Promise<void> {
  const ids = (only ?? enabled()).filter((id) => prefs.sync[id].enabled)
  if (!ids.length) return
  if (!manual && !prefs.sync.autoSync) return
  if (!(await onWifiOrManual(manual))) {
    await refreshPending()
    return
  }
  await Promise.all(ids.map(runOne))
}

let autoTimer: ReturnType<typeof setTimeout> | undefined
/** 日记有变化：刷新待同步数，并按自动同步设置在 2 秒后同步（把连续几次改动合并成一次） */
function onChange() {
  void refreshPending()
  clearTimeout(autoTimer)
  autoTimer = setTimeout(() => void syncNow(false), 2000)
}

/** 离开编辑页、app 切到后台时调用：立即按自动同步设置同步 */
export function syncAfterEdit() {
  clearTimeout(autoTimer)
  void refreshPending().then(() => syncNow(false))
}

export function initSync() {
  // 端到端测试用的调试入口
  const w = window as unknown as { __diary?: Record<string, unknown> }
  if (w.__diary) Object.assign(w.__diary, { engine, syncState, loadKeys })
  onDiaryChanged(onChange)
  onStarted(async () => {
    await refreshPending()
    if (enabled().some((id) => syncState[id].pending > 0)) void syncNow(false)
    void weeklyCheck()
  })
  if (Capacitor.isNativePlatform()) {
    CapApp.addListener('resume', async () => {
      await refreshPending()
      if (enabled().some((id) => syncState[id].pending > 0)) void syncNow(false)
      void weeklyCheck()
    })
  }
}

// ---------- 首次启用与恢复 ----------

export async function preview(id: BackendId): Promise<RestorePreview> {
  return previewRemote(await buildRemote(id))
}

export async function manifestEmpty(id: BackendId): Promise<boolean> {
  return Object.keys(await engine.readManifest(id)).length === 0
}

export const restoreState = reactive({ running: false, done: 0, total: 0, error: '', result: null as RestoreResult | null })

/** 云端加密时，本机已有同一把密钥就不用再输密码 */
export async function canDecrypt(pv: RestorePreview): Promise<boolean> {
  const k = await loadKeys()
  return !!k && !!pv.recipient && k.recipient === pv.recipient
}

/**
 * @param passphrase 云端加密且本机没有对应密钥时需要
 */
export async function restore(id: BackendId, passphrase?: string): Promise<RestoreResult | null> {
  if (restoreState.running) return null
  Object.assign(restoreState, { running: true, done: 0, total: 0, error: '', result: null })
  try {
    const remote = await buildRemote(id)
    const pv = await previewRemote(remote)
    let crypto: SyncCrypto | null = null
    if (pv.encrypted) {
      let keys = await loadKeys()
      if (!keys || keys.recipient !== pv.recipient) {
        if (!passphrase) throw new Error('云端是加密的，请输入同步加密密码')
        keys = await unlockRemote(remote, passphrase)
      }
      crypto = new SyncCrypto(keys)
    }
    const result = await restoreFrom(remote, store, engine, (done, total) => Object.assign(restoreState, { done, total }), crypto)
    if (crypto) {
      // 采用云端的密钥；另一个后端若用的是旧密钥加密，下次同步会自动按新密钥重传
      if ((await loadKeys())?.recipient !== crypto.keys.recipient) await saveKeys(crypto.keys)
      prefs.sync[id].encrypt = true
    }
    restoreState.result = result
    await repo.init()
    await reloadIndex(true)
    diaryChanged()
    return result
  } catch (e) {
    restoreState.error = (e as Error).message
    return null
  } finally {
    restoreState.running = false
  }
}

// ---------- 核对云端 ----------

const WEEK = 7 * 24 * 3600 * 1000

/** 核对一个后端；有缺失就接着同步。manual=false 时遵守“自动同步”和“仅 Wi‑Fi” */
export async function checkNow(id: BackendId, manual = true): Promise<CheckResult | null> {
  const s = syncState[id]
  if (!prefs.sync[id].enabled || s.check.running) return null
  if (!manual && (!prefs.sync.autoSync || !(await onWifiOrManual(false)))) return null
  s.check.running = true
  s.check.error = ''
  try {
    const result = await engine.reconcile(await buildRemote(id), await optsFor(id))
    Object.assign(s.check, { at: Date.now(), result })
    s.pending = await engine.pending(id, await optsFor(id))
    if (s.pending) void syncNow(manual, [id])
    return result
  } catch (e) {
    s.check.error = (e as Error).message
    return null
  } finally {
    s.check.running = false
  }
}

/** 打开 app、回到前台时：超过一周没核对的后端自动核对一次 */
async function weeklyCheck() {
  for (const id of enabled()) {
    const st = await engine.readState(id)
    if (!st.lastCheck || Date.now() - st.lastCheck > WEEK) void checkNow(id, false)
  }
}

/** 配置变了（换了 Bucket 或仓库）：清空该后端的清单，下次同步会全量上传 */
export async function resetManifest(id: BackendId) {
  await engine.clearManifest(id)
  await refreshPending()
}
