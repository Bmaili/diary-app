/**
 * 指纹解锁：调用本工程的原生插件 Biometric（android/.../BiometricPlugin.java）。
 * 浏览器里没有指纹，status() 返回不可用。端到端测试可以在 window.__biometricMock 上放一个假的实现。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

export interface BioStatus { available: boolean; reason: 'ok' | 'none-enrolled' | 'no-hardware' | 'unavailable' | 'web' }
export interface BioResult { ok: boolean; code?: number; message?: string }
interface BiometricPlugin {
  status(): Promise<BioStatus>
  authenticate(o: { title: string; subtitle?: string; cancel?: string }): Promise<BioResult>
}

const Native = registerPlugin<BiometricPlugin>('Biometric')
const impl = (): BiometricPlugin | null =>
  (window as unknown as { __biometricMock?: BiometricPlugin }).__biometricMock ?? (Capacitor.isNativePlatform() ? Native : null)

export async function biometricStatus(): Promise<BioStatus> {
  const p = impl()
  if (!p) return { available: false, reason: 'web' }
  try {
    return await p.status()
  } catch {
    return { available: false, reason: 'unavailable' }
  }
}

/** 系统错误码：7 / 9 是试错太多被锁，10 / 13 是用户取消 */
export async function biometricAuth(title: string, cancel = '用 PIN'): Promise<BioResult> {
  const p = impl()
  if (!p) return { ok: false, message: '这台设备不支持指纹' }
  try {
    return await p.authenticate({ title, cancel })
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}

export const BIO_REASON: Record<BioStatus['reason'], string> = {
  ok: '',
  'none-enrolled': '手机还没有录入指纹，先到系统设置里录入',
  'no-hardware': '这台手机没有可用的指纹识别',
  unavailable: '指纹识别暂时不可用',
  web: '只在手机上可用',
}
