/**
 * 应用内更新（2026-10-10 加入）。
 * - 自动检查：只在手机上、设置里开着（默认开）时，启动和回到前台时检查，两次至少隔一天。
 *   有新版时“设置 → 关于浮生记”那一行显示红点；点“暂不”后这个版本不再显示红点。
 * - 弹窗提醒（2026-10-19 加入，默认开，可以关）：打开 app、或离开超过 30 分钟后回来时弹一次，
 *   “更新”去关于页开始下载，“暂不”这一版不再弹，按返回键关掉的下次进来还弹。
 *   正在写日记、写信时不弹；有应用锁时解锁以后再弹；正在下载时不弹。
 * - 用户点“更新”才下载（原生插件，带进度、可取消），下完核对 sha256 和签名，再调起系统安装界面。
 * - 断点续传（2026-10-12）：失败、取消、app 被关掉后，下了一半的文件留着，下次接着下；
 *   换了版本（或同一版本的安装包变了）就作废，从头下。断线时原生端悄悄重试一次。
 *   覆盖安装会保留日记；签名不一致的安装包在 app 里就拦下，不会交给系统。
 * - 浏览器里（开发预览）不自动检查；手动检查后点“更新”打开 Releases 网页。
 * 检查结果存在 Preferences（diary/ 之外）。
 */
import { computed, reactive, watch } from 'vue'
import type { Router } from 'vue-router'
import { App as CapApp } from '@capacitor/app'
import { Preferences } from '@capacitor/preferences'
import { http } from './core/http'
import { AUTO_CHECK_MS, formatSize, isNewer, parseRelease, resumeOffset, type ReleaseInfo } from './core/update'
import { RELEASES_API, RELEASES_URL } from './appInfo'
import { enqueue, index, onStarted } from './app'
import { prefs } from './prefs'
import { AppUpdate, inAppUpdateSupported } from './platform/appUpdate'
import { expectExternal, lock } from './lockService'
import { showDialog } from './ui/dialog'

const KEY = 'update.v1'
export const currentVersion = __APP_VERSION__

export const updateState = reactive({
  checking: false,
  /** 上一次检查的错误（自动检查失败不显示） */
  error: '',
  lastCheck: 0,
  latest: null as ReleaseInfo | null,
  /** 点过“暂不”的版本 */
  dismissed: '',
  phase: 'idle' as 'idle' | 'downloading' | 'ready' | 'installing',
  done: 0,
  total: 0,
  /** 下载好的安装包路径 */
  path: '',
  /** 下载、安装过程中的提示或错误 */
  note: '',
  /** 上次下了一半、可以接着下的字节数（0 表示没有） */
  resumable: 0,
})

export const hasUpdate = computed(() => !!updateState.latest && isNewer(updateState.latest.version, currentVersion))
/** 设置页“关于浮生记”的红点 */
export const showBadge = computed(() => hasUpdate.value && updateState.latest!.version !== updateState.dismissed)

async function save() {
  const { lastCheck, latest, dismissed } = updateState
  await Preferences.set({ key: KEY, value: JSON.stringify({ lastCheck, latest, dismissed }) }).catch(() => {})
}

export async function checkUpdate(manual = true): Promise<void> {
  if (updateState.checking) return
  updateState.checking = true
  if (manual) updateState.error = ''
  try {
    const r = await http({ url: RELEASES_API, headers: { Accept: 'application/vnd.github+json' }, timeoutMs: 15000 })
    if (r.status === 403 || r.status === 429) throw new Error('检查得太频繁了，过一会儿再试')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const latest = parseRelease(r.json())
    // 换了一个更新的版本：之前下载好的旧安装包作废
    if (updateState.latest?.version !== latest.version && updateState.phase === 'ready') resetDownload()
    updateState.latest = latest
    // 下了一半的不是这个版本（或这个版本的安装包换了）：作废
    if (updateState.phase === 'idle') void refreshPartial()
    updateState.lastCheck = Date.now()
    updateState.error = ''
    await save()
  } catch (e) {
    if (manual) updateState.error = (e as Error).message
  } finally {
    updateState.checking = false
  }
}

async function autoCheck(): Promise<void> {
  if (!inAppUpdateSupported || !prefs.update.auto) return
  if (Date.now() - updateState.lastCheck < AUTO_CHECK_MS) return
  await checkUpdate(false)
}

// ---------- 弹窗提醒 ----------

/** 离开多久再回来算“进入软件” */
export const PROMPT_AWAY_MS = 30 * 60 * 1000
/** 这些页面上不弹：正在写日记、写信，或者本来就在关于页 */
const QUIET = [/^\/entry\//, /^\/letters\/new/, /^\/settings\/about/]
let routerRef: Router | null = null
let prompting = false

/** 现在该不该弹：开着自动检查和弹窗、有没点过“暂不”的新版本、没在下载、不在写东西的页面 */
export function shouldPrompt(path: string): boolean {
  return prefs.update.auto && prefs.update.popup && showBadge.value && updateState.phase === 'idle' && !QUIET.some((r) => r.test(path))
}

/** 进入软件时调用：锁着的话等解锁以后再看 */
export async function promptUpdate(): Promise<void> {
  if (lock.locked) {
    const stop = watch(() => lock.locked, (l) => {
      if (l) return
      stop()
      void promptUpdate()
    })
    return
  }
  const r = routerRef
  if (!r || prompting || !shouldPrompt(r.currentRoute.value.path)) return
  prompting = true
  try {
    const v = updateState.latest!.version
    const notes = updateState.latest!.notes.trim()
    const res = await showDialog({
      title: `新版本 ${v}`,
      message: `${notes ? `${notes.length > 240 ? `${notes.slice(0, 240)}…` : notes}\n\n` : ''}覆盖安装，日记不会丢。`,
      buttons: [
        { label: '暂不', value: 'later', kind: 'ghost' },
        { label: '更新', value: 'update', kind: 'primary' },
      ],
      dismiss: 'close',
    })
    if (res.value === 'later') dismissUpdate()
    else if (res.value === 'update') {
      await r.push('/settings/about')
      void startDownload()
    }
  } finally {
    prompting = false
  }
}

/** 弹窗要用路由（去关于页、看现在在哪个页面），由 App.vue 交进来 */
export function initUpdatePrompt(router: Router) {
  routerRef = router
  let hiddenAt = 0
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now()
    else if (hiddenAt && Date.now() - hiddenAt >= PROMPT_AWAY_MS) {
      // 回来时可能顺便检查了更新：等检查完再看
      void autoCheck().finally(() => void promptUpdate())
    }
  })
  onStarted(() => void ready.then(() => promptUpdate()))
  // 端到端测试里直接调用
  const w = window as unknown as { __diary?: Record<string, unknown> }
  if (w.__diary) Object.assign(w.__diary, { promptUpdate, updateState })
}

/** 启动时读完缓存、做完自动检查 */
let markReady: () => void = () => {}
const ready = new Promise<void>((r) => (markReady = r))

export function dismissUpdate() {
  if (!updateState.latest) return
  updateState.dismissed = updateState.latest.version
  void save()
}

function resetDownload() {
  Object.assign(updateState, { phase: 'idle', done: 0, total: 0, path: '' })
}

/** 在系统浏览器里打开 Releases 网页 */
export function openReleasePage() {
  const url = updateState.latest?.pageUrl || RELEASES_URL
  if (inAppUpdateSupported) window.location.href = url
  else window.open(url, '_blank', 'noopener')
}

let progressListening = false

/**
 * 核对下了一半的文件：还是要下的这个版本就记下进度（关于页显示“继续下载”），否则删掉。
 * 已经装上了这个版本（或更新的）时也删掉。只在没有进行中的下载、也没有等着安装的安装包时调用。
 */
async function refreshPartial(): Promise<void> {
  if (!inAppUpdateSupported) return
  const latest = updateState.latest
  const p = await AppUpdate.partial().catch(() => null)
  const keep = latest && isNewer(latest.version, currentVersion) ? resumeOffset(p, latest.version, latest.apk) : 0
  updateState.resumable = keep
  // 不能续传时整个目录清掉（也包括上次下完却没装的安装包）
  if (!keep) await AppUpdate.clean().catch(() => {})
}

export async function startDownload(): Promise<void> {
  const latest = updateState.latest
  if (!latest || updateState.phase !== 'idle') return
  if (!inAppUpdateSupported || !latest.apk) {
    openReleasePage()
    return
  }
  if (!progressListening) {
    progressListening = true
    void AppUpdate.addListener('progress', (e) => {
      if (updateState.phase === 'downloading') Object.assign(updateState, { done: e.done, total: e.total })
    })
  }
  const offset = resumeOffset(await AppUpdate.partial().catch(() => null), latest.version, latest.apk)
  Object.assign(updateState, { phase: 'downloading', done: offset, total: latest.apk.size, note: '' })
  try {
    const r = await AppUpdate.download({
      url: latest.apk.url, sha256: latest.apk.sha256, size: latest.apk.size, version: latest.version, offset,
    })
    Object.assign(updateState, { phase: 'ready', path: r.path, resumable: 0 })
    await installUpdate()
  } catch (e) {
    const err = e as { message?: string; code?: string }
    resetDownload()
    // 下了一半的留着：再点“继续下载”接着下
    await refreshPartial()
    const kept = updateState.resumable ? `已下载 ${formatSize(updateState.resumable)} / ${formatSize(latest.apk.size)}，再点“继续下载”会接着下` : ''
    updateState.note = err.code === 'CANCELLED'
      ? kept
      : `下载失败：${err.message ?? String(e)}${kept ? `。${kept}` : ''}`
  }
}

export async function cancelDownload() {
  await AppUpdate.cancel().catch(() => {})
}

/** 调起系统安装界面。还没允许“安装未知应用”时先去系统设置，回来后自动再试一次 */
export async function installUpdate(askPermission = true): Promise<void> {
  if (updateState.phase !== 'ready' || !updateState.path) return
  // 安装会结束这个进程：先把排队中的写盘做完，顺便存一下索引缓存
  await enqueue(() => index.saveCacheIfDirty()).catch(() => {})
  const done = expectExternal()
  try {
    const r = await AppUpdate.install({ path: updateState.path, askPermission })
    if (r.needPermission) {
      updateState.note = askPermission
        ? '请在打开的系统设置里允许浮生记“安装未知应用”，返回后会自动继续'
        : '还没有允许“安装未知应用”。允许后点“安装”'
      if (askPermission) {
        const h = await CapApp.addListener('resume', () => {
          void h.remove()
          void installUpdate(false)
        })
      }
    } else updateState.note = '在系统的安装界面点“安装”即可，日记不会丢'
  } catch (e) {
    updateState.note = `没能打开安装界面：${(e as Error).message}`
  } finally {
    // 用户在安装界面点了取消、回到 app 时，不要因此弹出应用锁
    const h = await CapApp.addListener('resume', () => {
      void h.remove()
      done()
    })
  }
}

export function initUpdate() {
  onStarted(async () => {
    try {
      const raw = (await Preferences.get({ key: KEY })).value
      if (raw) {
        const s = JSON.parse(raw) as { lastCheck?: number; latest?: ReleaseInfo | null; dismissed?: string }
        Object.assign(updateState, { lastCheck: Number(s.lastCheck) || 0, latest: s.latest ?? null, dismissed: s.dismissed ?? '' })
      }
    } catch { /* 坏了就当没检查过 */ }
    // 已经装上了新版、或者下了一半的不是要下的版本：清掉；还是要下的这一版就留着接着下
    void refreshPartial()
    await autoCheck().catch(() => {})
    markReady()
  })
  if (inAppUpdateSupported) void CapApp.addListener('resume', () => void autoCheck())
}
