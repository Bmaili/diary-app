/**
 * 原生插件 AppUpdate（android/.../AppUpdatePlugin.java）：在 app 里下载新版安装包、核对、调起系统安装界面。
 * 只用安卓系统自带的接口，不引入第三方库。浏览器里没有这个能力。
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

interface AppUpdatePlugin {
  /** 下载到 app 的缓存目录；核对 sha256、包名、签名和版本号，任何一项不对都报错并删掉文件 */
  download(o: { url: string; sha256: string; size: number }): Promise<{ path: string }>
  cancel(): Promise<void>
  /** 调起系统安装界面。还没允许“安装未知应用”时，打开对应的系统设置页并返回 needPermission */
  install(o: { path: string; askPermission: boolean }): Promise<{ started: boolean; needPermission?: boolean }>
  /** 删掉缓存里下载过的安装包 */
  clean(): Promise<void>
  addListener(ev: 'progress', fn: (e: { done: number; total: number }) => void): Promise<PluginListenerHandle>
}

export const AppUpdate = registerPlugin<AppUpdatePlugin>('AppUpdate')
export const inAppUpdateSupported = Capacitor.isNativePlatform()
