/**
 * 应用内更新（2026-10-10 加入）。
 * - 自动检查：只在手机上、设置里开着（默认开）时，启动和回到前台时检查，两次至少隔一天。
 *   有新版只在“设置 → 关于浮生记”那一行显示红点，别的页面不打扰。点“暂不”后这个版本不再显示红点。
 * - 用户点“更新”才下载（原生插件，带进度、可取消），下完核对 sha256 和签名，再调起系统安装界面。
 *   覆盖安装会保留日记；签名不一致的安装包在 app 里就拦下，不会交给系统。
 * - 浏览器里（开发预览）不自动检查；手动检查后点“更新”打开 Releases 网页。
 * 检查结果存在 Preferences（diary/ 之外）。
 */
import { computed, reactive } from 'vue'
import { App as CapApp } from '@capacitor/app'
import { Preferences } from '@capacitor/preferences'
import { http } from './core/http'
import { AUTO_CHECK_MS, isNewer, parseRelease, type ReleaseInfo } from './core/update'
import { RELEASES_API, RELEASES_URL } from './appInfo'
import { enqueue, index, onStarted } from './app'
import { prefs } from './prefs'
import { AppUpdate, inAppUpdateSupported } from './platform/appUpdate'
import { expectExternal } from './lockService'

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
    updateState.lastCheck = Date.now()
    updateState.error = ''
    await save()
  } catch (e) {
    if (manual) updateState.error = (e as Error).message
  } finally {
    updateState.checking = false
  }
}

function autoCheck() {
  if (!inAppUpdateSupported || !prefs.update.auto) return
  if (Date.now() - updateState.lastCheck < AUTO_CHECK_MS) return
  void checkUpdate(false)
}

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
  Object.assign(updateState, { phase: 'downloading', done: 0, total: latest.apk.size, note: '' })
  try {
    const r = await AppUpdate.download({ url: latest.apk.url, sha256: latest.apk.sha256, size: latest.apk.size })
    Object.assign(updateState, { phase: 'ready', path: r.path })
    await installUpdate()
  } catch (e) {
    const err = e as { message?: string; code?: string }
    resetDownload()
    updateState.note = err.code === 'CANCELLED' ? '' : `下载失败：${err.message ?? String(e)}`
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
    // 已经装上了新版（或者缓存里还留着上次下载的安装包）：清掉
    if (inAppUpdateSupported) void AppUpdate.clean().catch(() => {})
    autoCheck()
  })
  if (inAppUpdateSupported) void CapApp.addListener('resume', autoCheck)
}
