/**
 * 不含密钥的设置，存在 Preferences 里，改动后自动保存。密钥见 platform/secrets.ts。
 */
import { reactive, watch } from 'vue'
import { Preferences } from '@capacitor/preferences'

export interface LlmProfile {
  id: string
  name: string
  protocol: 'openai' | 'anthropic'
  baseUrl: string
  model: string
}

export const prefs = reactive({
  sync: {
    autoSync: true,
    wifiOnly: false,
    oss: { enabled: false, endpoint: '', bucket: '', prefix: 'diary/', accessKeyId: '', encrypt: false },
    github: { enabled: false, owner: '', repo: '', branch: 'main', apiBase: 'https://api.github.com', prefix: '', encrypt: false },
  },
  place: {
    autoLocate: true,
    weatherProvider: 'auto' as 'auto' | 'qweather' | 'openmeteo',
    qweatherHost: '',
    defaultCity: null as null | { name: string; lat: number; lng: number },
  },
  ai: {
    profiles: [] as LlmProfile[],
    use: { chat: '', extract: '', summary: '' },
    /** 已经确认过“会把日记发给该服务”的配置 id */
    consented: [] as string[],
    /** 给 AI 的补充说明（问答、抽取、总结都会带上） */
    notes: '',
  },
  reminder: {
    enabled: false,
    /** HH:mm */
    time: '22:00',
    /** 今天已经写过就不提醒 */
    skipWritten: true,
  },
  lock: {
    enabled: false,
    /** 切到后台多少秒后再回来需要解锁；0 表示立即 */
    delaySec: 60,
    /** 在最近任务里隐藏内容并禁止截屏 */
    hideInRecents: true,
  },
  /** 已显示过的一次性提示 */
  seen: [] as string[],
})

const KEY = 'prefs.v2'

function merge(target: Record<string, unknown>, src: Record<string, unknown>) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      merge(target[k] as Record<string, unknown>, v as Record<string, unknown>)
    } else if (k in target) target[k] = v
  }
}

let loaded = false
export async function loadPrefs() {
  const v = (await Preferences.get({ key: KEY })).value
  if (v) {
    try {
      merge(prefs as unknown as Record<string, unknown>, JSON.parse(v))
    } catch { /* 损坏就用默认值 */ }
  }
  loaded = true
}

let timer: ReturnType<typeof setTimeout> | undefined
watch(
  prefs,
  () => {
    if (!loaded) return
    clearTimeout(timer)
    timer = setTimeout(() => void Preferences.set({ key: KEY, value: JSON.stringify(prefs) }), 300)
  },
  { deep: true },
)

export function savePrefsNow() {
  clearTimeout(timer)
  return Preferences.set({ key: KEY, value: JSON.stringify(prefs) })
}
