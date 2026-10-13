/**
 * 随手翻一篇（2026-10-13 加入）：首页点一下，随机打开一篇旧日记。
 *
 * - 先从一个月以前、写了正文的日子里挑（最近的事还记得，只记了心情的日子打开也没什么可看）；
 *   没有的话放宽到今天以外、写了正文的；再没有就今天以外的任何一天。
 * - 不连着两次翻到同一篇。
 */
import type { IndexRow } from './types'
import { addDays } from './time'

export function pickWander(
  rows: Pick<IndexRow, 'date' | 'sections' | 'error'>[],
  today: string,
  last?: string,
  rnd: () => number = Math.random,
): string | null {
  const ok = rows.filter((r) => !r.error && r.date < today)
  const withBody = ok.filter((r) => r.sections !== 0)
  const monthAgo = addDays(today, -30)
  const tiers = [withBody.filter((r) => r.date <= monthAgo), withBody, ok]
  for (const tier of tiers) {
    const pool = tier.length > 1 ? tier.filter((r) => r.date !== last) : tier
    if (pool.length) return pool[Math.floor(rnd() * pool.length)].date
  }
  return null
}
