/**
 * 编辑页的位置和天气（规格 5.3、5.4）。
 * 当天第一次打开时自动记一次；补写往日日记不自动获取。点开天气框只是看和改，不会重新获取。
 */
import { computed, ref, type ComputedRef } from 'vue'
import { autoFill, fetchWeather, getPosition } from '../../placeService'
import { prefs } from '../../prefs'
import type { EntryMeta, Location, Weather } from '../../core/types'

export function usePlaceWeather(opts: {
  date: string
  meta: ComputedRef<EntryMeta | undefined>
  /** 改了元数据；now=false 时按节流保存 */
  changed: (now?: boolean) => void
  isLeft: () => boolean
  /** 显示一行提示 */
  note: (s: string) => void
}) {
  const { meta } = opts
  /** 选了“不记位置”的日子不再自动定位 */
  const skipKey = `nolocate:${opts.date}`
  const placeBusy = ref(false)
  const locOpen = ref(false)
  const weatherOpen = ref(false)

  async function fillPlace() {
    const m = meta.value
    if (!m || (m.location && m.weather) || !prefs.place.autoLocate) return
    placeBusy.value = true
    const r = await autoFill(m, { skipLocation: prefs.seen.includes(skipKey) }).finally(() => (placeBusy.value = false))
    if (opts.isLeft() || meta.value !== m) return
    let changed = false
    if (r.location && !m.location) {
      m.location = r.location
      changed = true
    }
    if (r.weather && !m.weather) {
      m.weather = r.weather
      changed = true
    }
    if (r.errors.length && !changed) opts.note(r.errors[0])
    if (changed) opts.changed(false)
  }

  function pickLocation(loc: Location | null) {
    const m = meta.value
    locOpen.value = false
    if (!m) return
    if (loc === null) {
      delete m.location
      if (!prefs.seen.includes(skipKey)) prefs.seen.push(skipKey)
    } else {
      m.location = loc
      // 选了具体地点，就把它算作“这天去过的地方”（自动带入，不算手动修改，不锁定）
      if (loc.name && !(m.places ?? []).includes(loc.name)) m.places = [...(m.places ?? []), loc.name]
    }
    opts.changed()
  }

  const locLabel = computed(() => {
    const l = meta.value?.location
    if (!l) return ''
    if (l.name) return l.name
    if (l.address) return l.address.replace(/^.+?(省|自治区)/, '').slice(0, 14)
    return '已记坐标'
  })

  /** 按现在的位置取天气，只在天气框里点“重新获取”时调用 */
  async function fetchNowWeather() {
    const m = meta.value
    const at = m?.location?.lat != null ? { lat: m.location.lat, lng: m.location.lng! } : await getPosition().catch(() => prefs.place.defaultCity)
    if (!at) throw new Error('没有位置，也没有设置默认城市')
    return fetchWeather(at.lat, at.lng)
  }

  function saveWeather(w: Weather | null) {
    const m = meta.value
    if (!m) return
    if (w) m.weather = w
    else delete m.weather
    opts.changed()
  }

  const weatherText = computed(() => {
    const w = meta.value?.weather
    if (!w) return ''
    return [w.text, w.temp_c != null ? `${w.temp_c}°C` : ''].filter(Boolean).join(' ')
  })

  return { placeBusy, locOpen, weatherOpen, fillPlace, pickLocation, locLabel, fetchNowWeather, saveWeather, weatherText }
}
