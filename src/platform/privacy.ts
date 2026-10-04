/**
 * 原生小插件 PrivacyScreen（android/.../PrivacyScreenPlugin.java）：给窗口加 FLAG_SECURE，
 * 最近任务里显示空白、并且禁止截屏和录屏。浏览器里没有这个能力，直接忽略。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

const PrivacyScreen = registerPlugin<{ set(o: { on: boolean }): Promise<void> }>('PrivacyScreen')

export async function setPrivacyScreen(on: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    await PrivacyScreen.set({ on })
  } catch {
    /* 老版本安装包里没有这个插件，忽略 */
  }
}
