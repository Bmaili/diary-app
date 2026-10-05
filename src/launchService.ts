/**
 * 从桌面快捷方式打开（2026-10-05 加入）：长按图标选“写今天”，安卓用
 * app.diary.local://write/today 这个链接启动或唤起应用（见 android/.../res/xml/shortcuts.xml）。
 * 冷启动时从 getLaunchUrl 取，应用已在后台时收到 appUrlOpen。
 */
import type { Router } from 'vue-router'
import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { today } from './app'
import { launchTarget, type LaunchTarget } from './core/launch'

export function openTarget(router: Router, target: LaunchTarget | null) {
  if (target === 'write-today') void router.push({ path: `/entry/${today()}`, query: { append: '1' } })
}

/** 在日记读取完成后调用 */
export function initLaunch(router: Router) {
  if (!Capacitor.isNativePlatform()) return
  void CapApp.getLaunchUrl()
    .then((r) => openTarget(router, launchTarget(r?.url)))
    .catch(() => {})
  void CapApp.addListener('appUrlOpen', (e) => openTarget(router, launchTarget(e.url)))
}
