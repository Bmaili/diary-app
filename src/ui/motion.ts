/**
 * 页面切换动画（2026-10-04 加入），用浏览器的 View Transitions API：
 * - 进入下一级页面（打开日记、设置子页）：新页从右侧推入，旧页左移变暗；返回时反过来。
 * - 切换底部标签：按标签顺序左右轻推并淡入淡出。
 * - 从日记列表打开日记：列表里那一条的正文“展开”成编辑页的正文，返回时收回去。
 * 不支持 View Transitions 的 WebView、系统开了“减少动画”、或设置里关了动态效果时，直接切换。
 */
import { nextTick } from 'vue'
import type { Router, RouteLocationNormalized } from 'vue-router'
import { prefs } from '../prefs'

const TABS = ['home', 'calendar', 'search', 'ai']

export function motionOn(): boolean {
  if (prefs.ui.motion === false) return false
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** 在 <html> 上标记，CSS 据此关掉所有动画 */
export function applyMotionClass() {
  document.documentElement.classList.toggle('no-motion', !motionOn())
}

function depth(r: RouteLocationNormalized): number {
  if (r.meta.tab) return 0
  return r.path.split('/').filter(Boolean).length
}

export function kindOf(to: RouteLocationNormalized, from: RouteLocationNormalized): string {
  const a = from.meta.tab as string | undefined
  const b = to.meta.tab as string | undefined
  if (a && b) return TABS.indexOf(b) >= TABS.indexOf(a) ? 'tab-fwd' : 'tab-back'
  const d = depth(to) - depth(from)
  if (d > 0) return 'push'
  if (d < 0) return 'pop'
  return 'fade'
}

const SHARED = 'entry-body'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function find(selector: string, ms = 160): Promise<HTMLElement | null> {
  for (let t = 0; t <= ms; t += 16) {
    const el = document.querySelector<HTMLElement>(selector)
    if (el) return el
    await wait(16)
  }
  return null
}

function rowSelector(date: string) {
  return `.row[data-date="${date}"] .content`
}

type VT = { finished: Promise<void> }
type StartVT = (cb: () => Promise<void>) => VT

export function installTransitions(router: Router) {
  const start = (document as unknown as { startViewTransition?: StartVT }).startViewTransition?.bind(document)
  if (!start) return
  let finish: (() => void) | null = null

  router.beforeResolve((to, from) => {
    // 首次进入、同一页面换参数（例如查询串）不做动画
    if (!from.matched.length || to.path === from.path || !motionOn()) return true
    finish?.()
    const kind = kindOf(to, from)
    document.documentElement.dataset.vt = kind
    // 共享元素：列表这一条 ↔ 编辑页正文
    const opening = from.path === '/' && to.path.startsWith('/entry/') ? String(to.params.date) : null
    const closing = to.path === '/' && from.path.startsWith('/entry/') ? String(from.params.date) : null
    const named: HTMLElement[] = []
    const name = (el: HTMLElement | null) => {
      if (!el) return
      el.style.viewTransitionName = SHARED
      named.push(el)
    }
    if (opening) name(document.querySelector<HTMLElement>(rowSelector(opening)))
    if (closing) name(document.querySelector<HTMLElement>('.editor .paper'))

    return new Promise<boolean>((resolve) => {
      const vt = start(async () => {
        await new Promise<void>((done) => {
          finish = done
          resolve(true)
          // 万一导航被取消，不要让页面一直冻住
          setTimeout(done, 800)
        })
        finish = null
        for (const el of named.splice(0)) el.style.viewTransitionName = ''
        if (opening) name(await find('.editor .paper'))
        if (closing) {
          const row = await find(rowSelector(closing), 32)
          // 那一条不在屏幕上就不做共享动画
          const r = row?.getBoundingClientRect()
          if (row && r && r.bottom > 0 && r.top < window.innerHeight) name(row)
        }
      })
      vt.finished.finally(() => {
        for (const el of named.splice(0)) el.style.viewTransitionName = ''
        delete document.documentElement.dataset.vt
      })
    })
  })

  router.afterEach(async () => {
    if (!finish) return
    await nextTick()
    await wait(0)
    finish?.()
  })
}
