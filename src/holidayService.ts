/**
 * 节假日联网更新（2026-10-05 加入）。数据见 core/holidays.ts。
 * 启动后检查：今年没有联网数据、或上次检查超过 3 天，就取今年和明年的文件
 * （明年的安排国务院公布前没有：文件不存在或是空的，都不算错）。先走 jsDelivr（国内一般能连上），失败再走 GitHub。
 * 结果存在 Preferences 里（diary/ 之外，可随时重取），失败就继续用上次的或内置的。
 */
import { ref } from 'vue'
import { Preferences } from '@capacitor/preferences'
import { http } from './core/http'
import { parseHolidayCn, setOnlineHolidays, type HolidayDay } from './core/holidays'
import { lunarDay, type LunarDay } from './core/lunar'
import { onStarted } from './app'
import { prefs } from './prefs'

const KEY = 'holidays.v1'
const STALE_MS = 3 * 86400_000
const SOURCES = [
  (y: number) => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${y}.json`,
  (y: number) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${y}.json`,
]

interface Cache {
  checkedAt: number
  years: Record<number, HolidayDay[]>
}

/** 联网数据每次变化加一；界面通过 lunar() 读农历时会跟着刷新 */
export const holidayVersion = ref(0)
export const holidayStatus = ref<{ busy: boolean; checkedAt: number; years: number[]; error: string }>({ busy: false, checkedAt: 0, years: [], error: '' })

/** 界面用的农历：和 lunarDay 一样，但节假日数据更新后会重新计算 */
export function lunar(date: string): LunarDay {
  void holidayVersion.value
  return lunarDay(date)
}

let cache: Cache = { checkedAt: 0, years: {} }

function apply() {
  setOnlineHolidays(prefs.calendar.holidayOnline ? cache.years : {})
  holidayStatus.value = { ...holidayStatus.value, checkedAt: cache.checkedAt, years: Object.keys(cache.years).map(Number).sort() }
  holidayVersion.value++
}

/** 取某一年：文件不存在返回 null；连不上或格式不对抛错 */
async function fetchYear(year: number): Promise<HolidayDay[] | null> {
  let lastErr: Error | null = null
  let missing = 0
  for (const url of SOURCES) {
    try {
      const r = await http({ url: url(year), timeoutMs: 10000 })
      // jsDelivr 的缓存可能比 GitHub 晚几天，404 时也去 GitHub 看一下
      if (r.status === 404) {
        missing++
        continue
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const days = parseHolidayCn(r.json(), year)
      if (days.length) return days
      // holiday-cn 会提前放一个 days 为空的文件，国务院公布后才有内容：空的当作还没公布，再看下一个源
      missing++
    } catch (e) {
      lastErr = e as Error
    }
  }
  // 有一个源明确说没有（另一个可能连不上）：当作还没公布
  if (missing) return null
  throw lastErr ?? new Error('取不到节假日数据')
}

export async function refreshHolidays(force = false): Promise<void> {
  if (!prefs.calendar.holidayOnline || holidayStatus.value.busy) return
  const now = Date.now()
  const year = new Date().getFullYear()
  if (!force && cache.years[year] && now - cache.checkedAt < STALE_MS) return
  holidayStatus.value = { ...holidayStatus.value, busy: true, error: '' }
  try {
    const years = { ...cache.years }
    for (const y of [year, year + 1]) {
      // 明年的取不到不影响今年的
      const days = await fetchYear(y).catch((e) => {
        if (y === year) throw e
        return null
      })
      if (days) years[y] = days
    }
    cache = { checkedAt: now, years }
    await Preferences.set({ key: KEY, value: JSON.stringify(cache) })
    apply()
  } catch (e) {
    holidayStatus.value = { ...holidayStatus.value, error: (e as Error).message }
  } finally {
    holidayStatus.value = { ...holidayStatus.value, busy: false }
  }
}

export function initHolidays() {
  onStarted(async () => {
    try {
      const raw = (await Preferences.get({ key: KEY })).value
      if (raw) cache = JSON.parse(raw) as Cache
    } catch {
      cache = { checkedAt: 0, years: {} }
    }
    apply()
    void refreshHolidays()
  })
}

/** 设置里开关时调用 */
export function holidaySourceChanged() {
  apply()
  if (prefs.calendar.holidayOnline) void refreshHolidays()
}
