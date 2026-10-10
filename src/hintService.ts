/**
 * 首页小提示的换句节奏（2026-10-10 加入）：
 * - 打开 app、从后台回来时，离上次换句超过 30 分钟就换一句；
 * - 跨了时段（清晨、上午……）或跨了一天，随时换；
 * - 只是切换页面不换，免得来回切几下句子就变来变去。
 * 换句只是换随机数种子（句子怎么挑见 core/hints.ts）。种子存在 localStorage：丢了也只是多换一次句子。
 */
import { ref } from 'vue'

const KEY = 'hint.v1'
const STALE_MS = 30 * 60 * 1000

interface State { n: number; at: number; date: string; slot: string }

function load(): State {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as State | null
    if (s && typeof s.n === 'number') return s
  } catch { /* 读不了就从头来 */ }
  return { n: 0, at: 0, date: '', slot: '' }
}

let state = load()
export const hintSeed = ref('')

/**
 * @param resumed 是打开 app 或从后台回来（这时才看 30 分钟）；切页面回到首页时传 false
 */
export function refreshHintSeed(date: string, slot: string, resumed: boolean) {
  const now = Date.now()
  const stale = state.date !== date || state.slot !== slot || (resumed && now - state.at >= STALE_MS)
  if (stale) {
    state = { n: state.n + 1, at: now, date, slot }
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch { /* 存不了就算了 */ }
  }
  const seed = `${date}|${slot}|${state.n}`
  if (hintSeed.value !== seed) hintSeed.value = seed
}
