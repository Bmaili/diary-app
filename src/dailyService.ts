/**
 * 首页的每日诗词（2026-10-05 加入）。
 * - local（默认）：内置诗词库，按节日、节气、季节挑，离线。
 * - online：“今日诗词”接口（v2.jinrishici.com），它会按时间、天气、地点（根据 IP）推荐；每天只请求一次，失败就用内置的。
 * - off：不显示。
 */
import { reactive } from 'vue'
import { Preferences } from '@capacitor/preferences'
import { http } from './core/http'
import { poemFor } from './core/poems'
import { lunarDay } from './core/lunar'
import { prefs } from './prefs'

export interface DailyView {
  date: string
  text: string
  author: string
  title: string
  reason: string
  source: 'local' | 'online' | ''
  offset: number
  busy: boolean
}

export const daily = reactive<DailyView>({ date: '', text: '', author: '', title: '', reason: '', source: '', offset: 0, busy: false })

const CACHE = 'daily.v1'
const TOKEN = 'daily.token'
const API = 'https://v2.jinrishici.com'

function showLocal(date: string, offset: number) {
  const { poem, reason } = poemFor(date, offset)
  Object.assign(daily, { date, text: poem.text, author: poem.author, title: poem.title, reason, source: 'local', offset })
}

async function token(): Promise<string> {
  const t = (await Preferences.get({ key: TOKEN })).value
  if (t) return t
  const r = await http({ url: `${API}/token`, timeoutMs: 8000 })
  const j = r.json<{ status: string; data: string }>()
  if (j.status !== 'success' || !j.data) throw new Error('今日诗词没有返回 token')
  await Preferences.set({ key: TOKEN, value: j.data })
  return j.data
}

interface Online { text: string; author: string; title: string; reason: string }

async function fetchOnline(): Promise<Online> {
  const r = await http({ url: `${API}/sentence`, headers: { 'X-User-Token': await token() }, timeoutMs: 8000 })
  const j = r.json<{ status: string; data?: { content: string; matchTags?: string[]; origin?: { title?: string; dynasty?: string; author?: string } } }>()
  if (j.status !== 'success' || !j.data?.content) throw new Error('今日诗词没有返回内容')
  const o = j.data.origin ?? {}
  return {
    text: j.data.content,
    author: [o.dynasty, o.author].filter(Boolean).join(' · '),
    title: o.title ?? '',
    reason: (j.data.matchTags ?? []).slice(0, 2).join(' · ') || '今日诗词',
  }
}

export async function loadDaily(date: string, force = false): Promise<void> {
  if (prefs.daily.mode === 'off') {
    daily.text = ''
    return
  }
  if (!force && daily.date === date && daily.text && daily.source === (prefs.daily.mode === 'online' ? 'online' : 'local')) return
  showLocal(date, 0)
  if (prefs.daily.mode !== 'online') return
  try {
    const c = JSON.parse((await Preferences.get({ key: CACHE })).value ?? 'null') as { date: string; item: Online } | null
    if (c?.date === date && !force) {
      Object.assign(daily, c.item, { source: 'online', date })
      return
    }
    daily.busy = true
    const item = await fetchOnline()
    await Preferences.set({ key: CACHE, value: JSON.stringify({ date, item }) })
    Object.assign(daily, item, { source: 'online', date })
  } catch {
    /* 联网失败：保留内置的那句 */
  } finally {
    daily.busy = false
  }
}

/** 换一首：内置的往后换；联网的再请求一次 */
export async function nextPoem(): Promise<void> {
  if (daily.busy) return
  if (daily.source === 'online') {
    daily.busy = true
    try {
      const item = await fetchOnline()
      Object.assign(daily, item)
      return
    } catch {
      /* 失败就换成内置的 */
    } finally {
      daily.busy = false
    }
  }
  showLocal(daily.date, daily.source === 'local' ? daily.offset + 1 : 0)
}

/** 首页标题下的一行：农历、节气 */
export function almanac(date: string): string {
  const l = lunarDay(date)
  const hol = l.holiday ? (l.holiday.off ? `${l.holiday.name}假期` : '调休上班') : ''
  return [l.full, l.festival, l.jieqi ?? `${l.term}时节`, hol].filter(Boolean).join(' · ')
}
