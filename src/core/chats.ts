/**
 * 问答记录的保留规则（2026-10-22 加入，规格 7.3）：最近的对话只留 RECENT_MAX 段，
 * 收藏的不算在里面，多久以前的都不会被挤掉。记录只在本机（ai/chats.json），不同步、不进导出。
 */
export const RECENT_MAX = 50

export interface Keepable {
  updatedAt: number
  starred?: boolean
}

/** 新的在前；收藏的全留，没收藏的留最近 RECENT_MAX 段 */
export function trimChats<T extends Keepable>(list: T[], max = RECENT_MAX): T[] {
  const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  let n = 0
  return sorted.filter((c) => c.starred || n++ < max)
}

/** “以前的对话”里分两栏：收藏的、最近的（都是新的在前） */
export function splitChats<T extends Keepable>(list: T[]): { starred: T[]; recent: T[] } {
  return { starred: list.filter((c) => c.starred), recent: list.filter((c) => !c.starred) }
}
