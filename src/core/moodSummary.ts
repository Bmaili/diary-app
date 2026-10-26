/**
 * 日历页“这个月心情多是 X”（2026-10-26 起）：取天数最多的那一档，而不是平均分。
 * 平均分会被几天低谷拉下来：十天“不错”加四天“很差”“不好”，平均是“一般”，可一天“一般”都没有。
 * 两档天数一样多时，取离平均值近的那档；还一样近，取靠中间（离 3 近）的那档。
 */
export function dominantMood(moods: number[]): { mood: number; days: number } | null {
  if (!moods.length) return null
  const count = new Map<number, number>()
  for (const m of moods) count.set(m, (count.get(m) ?? 0) + 1)
  const avg = moods.reduce((a, b) => a + b, 0) / moods.length
  let best: { mood: number; days: number } | null = null
  for (const [mood, days] of count) {
    if (!best || days > best.days) {
      best = { mood, days }
      continue
    }
    if (days < best.days) continue
    const d = Math.abs(mood - avg) - Math.abs(best.mood - avg)
    if (d < -1e-9 || (Math.abs(d) <= 1e-9 && Math.abs(mood - 3) < Math.abs(best.mood - 3))) best = { mood, days }
  }
  return best
}
