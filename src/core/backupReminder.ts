/**
 * 首页的备份提醒（2026-10-13 加入）。日记默认只在手机上：手机丢了、坏了或卸载重装就全没了。
 * 写满 10 篇，并且既没开云端同步、30 天内也没导出过 zip 时，在首页提示一次；点 × 之后不再提醒。
 */
export const BACKUP_MIN_ENTRIES = 10
export const BACKUP_EXPORT_DAYS = 30

export function backupDue(o: {
  entries: number
  /** 开着的同步后端个数 */
  syncOn: number
  /** 上次导出 zip 的时间（ISO 字符串，没导出过为空） */
  lastExport: string
  dismissed: boolean
  now?: Date
}): boolean {
  if (o.dismissed || o.syncOn > 0 || o.entries < BACKUP_MIN_ENTRIES) return false
  if (!o.lastExport) return true
  const t = Date.parse(o.lastExport)
  if (!Number.isFinite(t)) return true
  return (o.now ?? new Date()).getTime() - t > BACKUP_EXPORT_DAYS * 86400000
}
