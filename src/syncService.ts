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
import { getSecret } from './platform/secrets'
import { SyncEngine } from './core/sync/engine'
import { OssStore } from './core/sync/oss'
import { GitHubStore } from './core/sync/github'
import type { RemoteStore } from './core/sync/remote'
import { previewRemote, restoreFrom, type RestorePreview, type RestoreResult } from './core/sync/restore'

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
}

const blank = (): BackendState => ({ status: 'off', pending: 0, lastOk: null, error: '', progress: null, nextRetry: null })
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

export async function refreshPending() {
  for (const b of BACKENDS) {
    const s = syncState[b.id]
    if (!prefs.sync[b.id].enabled) {
      Object.assign(s, blank())
      continue
    }
    if (s.status === 'off') s.status = 'idle'
    s.pending = await engine.pending(b.id)
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
    await engine.sync(remote, (done, total) => (s.progress = { done, total }))
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
    s.pending = await engine.pending(id).catch(() => s.pending)
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
  if (w.__diary) Object.assign(w.__diary, { engine, syncState })
  onDiaryChanged(onChange)
  onStarted(async () => {
    await refreshPending()
    if (enabled().some((id) => syncState[id].pending > 0)) void syncNow(false)
  })
  if (Capacitor.isNativePlatform()) {
    CapApp.addListener('resume', async () => {
      await refreshPending()
      if (enabled().some((id) => syncState[id].pending > 0)) void syncNow(false)
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

export async function restore(id: BackendId): Promise<RestoreResult | null> {
  if (restoreState.running) return null
  Object.assign(restoreState, { running: true, done: 0, total: 0, error: '', result: null })
  try {
    const result = await restoreFrom(await buildRemote(id), store, engine, (done, total) => Object.assign(restoreState, { done, total }))
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

/** 配置变了（换了 Bucket 或仓库）：清空该后端的清单，下次同步会全量上传 */
export async function resetManifest(id: BackendId) {
  await engine.clearManifest(id)
  await refreshPending()
}
