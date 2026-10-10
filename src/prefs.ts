/**
 * 不含密钥的设置，存在 Preferences 里，改动后自动保存。密钥见 platform/secrets.ts。
 */
import { reactive, watch } from 'vue'
import { Preferences } from '@capacitor/preferences'
import type { PromptOverride } from './core/llm/prompts'

export interface LlmProfile {
  id: string
  name: string
  protocol: 'openai' | 'anthropic'
  baseUrl: string
  model: string
  /** 高级设置，都可以不填 */
  contextTokens?: number
  maxOutput?: number
  temperature?: number
  timeoutSec?: number
  /** 合并进请求体的 JSON，原样保存用户输入 */
  extraBody?: string
  /** 问答流式输出，不填为开 */
  stream?: boolean
}

export const prefs = reactive({
  sync: {
    autoSync: true,
    wifiOnly: false,
    /** 停笔多少分钟后自动同步；0 表示离开编辑页就同步。期间再改会重新计时，多次修改只传一次 */
    quietMin: 2,
    /** 切到后台时，有没传的改动就立即同步（app 在后台可能被系统清掉，计时器不一定能走完） */
    syncOnHide: true,
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
    use: { chat: '', extract: '', summary: '', caption: '' },
    /** 已经确认过“会把日记发给该服务”的配置 id */
    consented: [] as string[],
    /** 给 AI 的补充说明（问答、抽取、总结都会带上） */
    notes: '',
    /** 只给某一项功能的补充说明，接在共用说明后面 */
    taskNotes: { chat: '', extract: '', summary: '', caption: '' },
    /** 问答：带上最近几轮对话、最多调用几轮工具 */
    chat: { historyTurns: 10, maxRounds: 10 },
    /** 批量抽取同时处理几篇 */
    extract: { concurrency: 2 },
    /** 插图后自动让 AI 看图写一句说明（会把这张图发给 AI 服务），默认关 */
    caption: { auto: false },
    /**
     * 改过的系统提示词（2026-10-07 加入），没改的是 null（用默认）。
     * 键要事先列全：读取设置时只合并已有的键。
     */
    prompts: { chat: null, extract: null, monthly: null, monthlyPart: null, yearly: null, caption: null } as Record<
      'chat' | 'extract' | 'monthly' | 'monthlyPart' | 'yearly' | 'caption', PromptOverride | null
    >,
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
    /** 指纹解锁（PIN 仍可用） */
    biometric: false,
  },
  daily: {
    /** 首页的每日诗词：local 内置诗词库，online 今日诗词接口，off 不显示 */
    mode: 'local' as 'local' | 'online' | 'off',
  },
  calendar: {
    /** 法定节假日联网更新（holiday-cn）；关掉只用内置数据 */
    holidayOnline: true,
  },
  ui: {
    /** 动态效果（页面切换、列表入场、日历跟手滑动等）；系统开了“减少动画”时也会关掉 */
    motion: true,
  },
  update: {
    /** 自动检查新版本（2026-10-10 加入）：每天最多一次，有新版只在设置里显示红点 */
    auto: true,
  },
  /** 已显示过的一次性提示 */
  seen: [] as string[],
})

const KEY = 'prefs.v2'

/** 把 src 合并进 target：只认 target 里已有的键（导入设置也用它） */
export function merge(target: Record<string, unknown>, src: Record<string, unknown>) {
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
  // 1.0.4 起问答的这两项最少 10
  prefs.ai.chat.historyTurns = Math.max(10, Number(prefs.ai.chat.historyTurns) || 10)
  prefs.ai.chat.maxRounds = Math.max(10, Number(prefs.ai.chat.maxRounds) || 10)
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
