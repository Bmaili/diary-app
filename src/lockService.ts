/**
 * 应用锁：启动时、以及离开 app 超过设定时间再回来时，要求输入 PIN。
 * 只是一道门帘（文件仍是明文），所以 PIN 忘了没有后门，只能清除 app 数据——见设置页的说明。
 */
import { reactive, watch } from 'vue'
import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { onStarted } from './app'
import { prefs, savePrefsNow } from './prefs'
import { getSecret, setSecret } from './platform/secrets'
import { setPrivacyScreen } from './platform/privacy'
import { hashPin, lockoutSeconds, verifyPin, type PinRecord } from './core/pin'

export const lock = reactive({
  locked: false,
  failures: 0,
  /** 输错太多次后，到这个时间之前不能再试（毫秒时间戳） */
  until: 0,
  len: 4,
})

const SECRET = 'lock.pin'
let hiddenAt: number | null = null
/** 调起系统相册、分享面板时会切到后台，这一次回来不上锁 */
let external = false

async function record(): Promise<PinRecord | null> {
  const s = await getSecret(SECRET)
  if (!s) return null
  try {
    return JSON.parse(s) as PinRecord
  } catch {
    return null
  }
}

export async function setPin(pin: string): Promise<void> {
  const rec = await hashPin(pin)
  await setSecret(SECRET, JSON.stringify(rec))
  lock.len = rec.len
  prefs.lock.enabled = true
  await savePrefsNow()
}

export async function checkPin(pin: string): Promise<boolean> {
  const rec = await record()
  if (!rec) return true
  return verifyPin(pin, rec)
}

export async function disableLock(): Promise<void> {
  await setSecret(SECRET, '')
  prefs.lock.enabled = false
  lock.locked = false
  await savePrefsNow()
}

/** 锁屏上输入 PIN。返回 'ok' | 'wrong' | 'wait' */
export async function unlock(pin: string): Promise<'ok' | 'wrong' | 'wait'> {
  if (Date.now() < lock.until) return 'wait'
  if (await checkPin(pin)) {
    lock.locked = false
    lock.failures = 0
    lock.until = 0
    return 'ok'
  }
  lock.failures++
  const wait = lockoutSeconds(lock.failures)
  if (wait) lock.until = Date.now() + wait * 1000
  return 'wrong'
}

/** 调起外部界面前调用；返回的函数在外部界面结束后调用，清掉没用上的标记 */
export function expectExternal(): () => void {
  external = true
  return () => setTimeout(() => (external = false), 1000)
}

function onHide() {
  if (hiddenAt == null) hiddenAt = Date.now()
}

function onShow() {
  const at = hiddenAt
  hiddenAt = null
  if (external) {
    external = false
    return
  }
  if (!prefs.lock.enabled || at == null) return
  if (Date.now() - at >= prefs.lock.delaySec * 1000) lock.locked = true
}

function applyPrivacy() {
  void setPrivacyScreen(prefs.lock.enabled && prefs.lock.hideInRecents)
}

export function initLock() {
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? onHide() : onShow()))
  if (Capacitor.isNativePlatform()) {
    void CapApp.addListener('pause', onHide)
    void CapApp.addListener('resume', onShow)
  }
  onStarted(() => {
    // 同步上锁，避免首屏先把日记画出来
    if (prefs.lock.enabled) lock.locked = true
    applyPrivacy()
    void record().then((rec) => {
      if (rec) lock.len = rec.len
      else if (prefs.lock.enabled) {
        // 设置里开着但 PIN 丢了（例如加密存储被清空）：不能把人锁在外面
        prefs.lock.enabled = false
        lock.locked = false
      }
    })
    watch(() => [prefs.lock.enabled, prefs.lock.hideInRecents], applyPrivacy)
  })
}
