/**
 * 词表合并（规格 7.4）：把几个写法合并成一个，改写所有涉及的文件。
 * 合并视为改名：不改变锁定状态，也不更新 updated。
 */
import type { DiaryIndex } from './diaryIndex'
import type { DiaryRepo } from './repo'
import type { ListField } from './types'

export async function mergeValues(
  repo: DiaryRepo, index: DiaryIndex, field: ListField, from: string[], to: string,
  onFile?: (date: string) => Promise<void>,
): Promise<number> {
  const target = to.trim()
  if (!target) throw new Error('合并后的名字不能为空')
  const src = new Set(from.map((s) => s.trim()).filter((s) => s && s !== target))
  if (!src.size) return 0
  let changed = 0
  for (const r of index.all()) {
    if (!r[field].some((v) => src.has(v))) continue
    const doc = await repo.readEntry(r.date).catch(() => null)
    if (!doc) continue
    const before = doc.meta[field] ?? []
    const after = [...new Set(before.map((v) => (src.has(v) ? target : v)))]
    doc.meta[field] = after
    // 位置名同步改名
    if (field === 'places' && doc.meta.location?.name && src.has(doc.meta.location.name)) doc.meta.location.name = target
    await repo.saveEntry(doc, new Date(), { touchUpdated: false })
    await onFile?.(r.date)
    changed++
  }
  return changed
}
