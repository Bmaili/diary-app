/** 写日记提醒：用本地通知预排未来 14 天，见 core/reminder.ts。只在手机上有效。 */
import { watch } from 'vue'
import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { index, indexVersion, onStarted, settings, today } from './app'
import { prefs } from './prefs'
import { planReminders, REMINDER_BASE_ID, REMINDER_DAYS } from './core/reminder'
import { router } from './ui/router'

const CHANNEL = 'reminder'
export const reminderSupported = Capacitor.isNativePlatform()

/** 打开开关时调用：申请通知权限。返回是否获准 */
export async function requestReminderPermission(): Promise<boolean> {
  if (!reminderSupported) return false
  const p = await LocalNotifications.requestPermissions()
  return p.display === 'granted'
}

let running: Promise<void> = Promise.resolve()
export function reschedule(): Promise<void> {
  running = running.then(doReschedule, doReschedule).catch(() => {})
  return running
}

async function doReschedule() {
  if (!reminderSupported) return
  const pending = await LocalNotifications.getPending()
  const ours = pending.notifications.filter((n) => n.id >= REMINDER_BASE_ID && n.id < REMINDER_BASE_ID + 100)
  if (ours.length) await LocalNotifications.cancel({ notifications: ours.map((n) => ({ id: n.id })) })
  if (!prefs.reminder.enabled) return
  // 只检查不申请：没有权限时静默不排，避免每次打开 app 都弹窗
  if ((await LocalNotifications.checkPermissions()).display !== 'granted') return
  const plan = planReminders({
    now: new Date(),
    today: today(),
    time: prefs.reminder.time,
    cutoffHour: settings.cutoffHour,
    written: (d) => !!index.get(d),
    skipWritten: prefs.reminder.skipWritten,
    days: REMINDER_DAYS,
  })
  if (!plan.length) return
  await LocalNotifications.schedule({
    notifications: plan.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      channelId: CHANNEL,
      schedule: { at: r.at, allowWhileIdle: true },
      // 不用精确闹钟：否则安卓 14 会在每次排程时跳到“闹钟和提醒”设置页。代价是可能晚几分钟。
      isExactNotification: false,
      autoCancel: true,
      extra: { date: r.date },
    })),
  })
}

export function initReminder() {
  if (!reminderSupported) return
  void LocalNotifications.createChannel({ id: CHANNEL, name: '写日记提醒', description: '每天提醒写一句日记', importance: 3 }).catch(() => {})
  void LocalNotifications.addListener('localNotificationActionPerformed', () => {
    void router.push(`/entry/${today()}`)
  })
  onStarted(() => {
    void reschedule()
    watch(() => [prefs.reminder.enabled, prefs.reminder.time, prefs.reminder.skipWritten, settings.cutoffHour], () => void reschedule())
  })
  // 写了今天的日记（索引变化）后，把今天的提醒撤掉
  let t: ReturnType<typeof setTimeout> | undefined
  watch(indexVersion, () => {
    clearTimeout(t)
    t = setTimeout(() => void reschedule(), 3000)
  })
  void CapApp.addListener('resume', () => void reschedule())
}
