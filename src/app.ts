/** 全局服务：文件仓库、索引、设置，以及一个串行写入队列。 */
import { reactive, ref } from 'vue'
import { Preferences } from '@capacitor/preferences'
import { DiaryRepo } from './core/repo'
import { DiaryIndex } from './core/diaryIndex'
import { CapacitorStore } from './platform/capStore'
import { diaryDate } from './core/time'
import { Capacitor } from '@capacitor/core'
import { setHttpImpl, setStreamImpl } from './core/http'
import { nativeHttpImpl } from './platform/nativeHttp'
import { nativeStreamImpl } from './platform/nativeStream'
import { loadPrefs } from './prefs'
import { purgeTrash, trashEntry, trashImages } from './core/trash'
import { findOrphans, mdFor, removedInSession, type OrphanImage } from './core/orphans'

export const store = new CapacitorStore()
export const repo = new DiaryRepo(store)
export const index = new DiaryIndex(repo, store)

export const settings = reactive({
  cutoffHour: 4,
  devMode: false,
})

/** 索引每次变化时递增，视图据此重新计算 */
export const indexVersion = ref(0)
export const ready = ref(false)
/** 建索引的进度（要读的文件多时，启动画面和设置里显示） */
export const indexProgress = reactive({ done: 0, total: 0 })
const onIndexProgress = (done: number, total: number) => Object.assign(indexProgress, { done, total })
export const loadError = ref<string | null>(null)

let started: Promise<void> | null = null

export function start(): Promise<void> {
  started ??= (async () => {
    try {
      const c = await Preferences.get({ key: 'cutoffHour' })
      if (c.value != null && !Number.isNaN(Number(c.value))) settings.cutoffHour = Number(c.value)
      settings.devMode = (await Preferences.get({ key: 'devMode' })).value === '1'
      if (Capacitor.isNativePlatform()) {
        setHttpImpl(nativeHttpImpl)
        setStreamImpl(nativeStreamImpl)
      }
      await loadPrefs()
      await repo.init()
      await index.load({ onProgress: onIndexProgress })
      Object.assign(indexProgress, { done: 0, total: 0 })
      indexVersion.value++
      ready.value = true
      void purgeTrash(store).catch(() => {})
      for (const fn of startHooks) fn()
    } catch (e) {
      loadError.value = (e as Error).message
      throw e
    }
  })()
  return started
}

const startHooks: (() => void)[] = []
/** 启动完成后要做的事（例如检查待同步） */
export function onStarted(fn: () => void) {
  if (ready.value) fn()
  else startHooks.push(fn)
}

/** 日记文件有变化（保存、删除、AI 写回、恢复）后调用，通知同步等模块 */
const changeHooks: (() => void)[] = []
export function onDiaryChanged(fn: () => void) {
  changeHooks.push(fn)
}
export function diaryChanged() {
  for (const fn of changeHooks) fn()
}

export async function setCutoffHour(h: number) {
  settings.cutoffHour = h
  await Preferences.set({ key: 'cutoffHour', value: String(h) })
}

export async function setDevMode(on: boolean) {
  settings.devMode = on
  await Preferences.set({ key: 'devMode', value: on ? '1' : '0' })
}

export function today(): string {
  return diaryDate(new Date(), settings.cutoffHour)
}

/** 所有写盘操作排队执行，避免自动保存与离开页面时的保存交错。 */
let queue: Promise<unknown> = Promise.resolve()
export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => {})
  return next
}

/** 删除一篇日记：移到“最近删除”，并通知同步（云端副本在下次同步时删除） */
export async function deleteEntryToTrash(date: string): Promise<void> {
  await enqueue(async () => {
    await trashEntry(repo, date)
    await refreshDate(date)
  })
  diaryChanged()
}

/**
 * 离开编辑页后：这次从正文里去掉的图片移到最近删除（规格 4.10）。在写入队列里排在最后一次保存之后，
 * 只有真的去掉了图才会去翻其他日记，平时不花时间。
 */
export function sweepRemovedImages(date: string, originalBody: string, openedAt: number): void {
  void enqueue(async () => {
    const removed = await removedInSession(repo, date, originalBody, openedAt)
    return removed.length ? trashImages(store, removed, date, 'edit') : null
  })
    .then((item) => item && diaryChanged())
    .catch(() => {})
}

/** 设置里的“清理没用到的图片”：先找 */
export function scanOrphans(): Promise<OrphanImage[]> {
  return enqueue(() => findOrphans(repo))
}

/** 再移到最近删除（一次一条） */
export async function trashOrphans(images: OrphanImage[]): Promise<number> {
  const n = await enqueue(async () => {
    // 从找到到确认之间可能又写了日记：移动前再核对一遍，只动两次都没被用到的
    const still = new Set((await findOrphans(repo)).map((o) => o.rel))
    const go = images.filter((i) => still.has(i.rel))
    await trashImages(store, go.map((i) => ({ rel: i.rel, md: mdFor(i.rel) })), today(), 'cleanup')
    return go.length
  })
  if (n) diaryChanged()
  return n
}

export async function refreshDate(date: string) {
  await index.refresh(date)
  indexVersion.value++
}

/**
 * 索引缓存只在 app 切到后台时写盘。整份缓存要序列化成一个大 JSON（几千篇时有几 MB），
 * 在前台写会让界面卡一下（以前改完日记 5 秒后写，常常正好碰上在首页滑动）。
 * 缓存只是加速启动用：没写成也没关系，下次启动会按文件修改时间补上改过的几篇。
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void enqueue(() => index.saveCacheIfDirty())
})

// 端到端测试用的调试入口（只在本页面内可见，不涉及任何外部访问）
;(window as unknown as { __diary: unknown }).__diary = { repo, index, settings }

export async function reloadIndex(full = false) {
  try {
    if (full) await index.rebuild({ onProgress: onIndexProgress })
    else await index.load({ onProgress: onIndexProgress })
  } finally {
    Object.assign(indexProgress, { done: 0, total: 0 })
  }
  indexVersion.value++
}
