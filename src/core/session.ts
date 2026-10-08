/**
 * 一次编辑会话的规则（规格 4.4 第 5 条、5.2）。
 * - 从“写今天”进入且当天已有内容：在末尾追加 `### HH:mm` 标题，光标放在标题的下一行（2026-10-07 起标题和正文之间不空行）。
 * - 什么都没写就离开：不保留这个空标题。
 */
import { parseEntry, serializeEntry, type EntryDoc } from './entryFile'
import { hhmm } from './time'
import type { DiaryRepo } from './repo'
import { hasContent } from './entryFile'

export interface EditSession {
  date: string
  doc: EntryDoc
  /** 打开时文件里的正文（不存在则为空串） */
  originalBody: string
  /** 编辑框的初始文字 */
  initialText: string
  appended: boolean
  existed: boolean
  /** 打开时文件的原文（新的一天为 undefined）。改了又改回去时写回它，文件一字不差，不会触发同步 */
  originalRaw?: string
  /** 文件无法解析时为错误信息，编辑页只读显示 */
  error?: string
}

export async function openSession(
  repo: DiaryRepo,
  date: string,
  opts: { append: boolean; now?: Date },
): Promise<EditSession> {
  let doc: EntryDoc | null = null
  const raw = await repo.readEntryRaw(date)
  try {
    if (raw != null) doc = parseEntry(raw, date)
  } catch (e) {
    return {
      date, doc: { meta: { date }, body: raw ?? '', extra: [] },
      originalBody: raw ?? '', initialText: raw ?? '', appended: false, existed: true,
      error: (e as Error).message,
    }
  }
  const existed = doc != null
  doc ??= { meta: { date }, body: '', extra: [] }
  const originalBody = doc.body
  if (opts.append && existed && hasContent(originalBody)) {
    const initialText = `${originalBody.trimEnd()}\n\n### ${hhmm(opts.now ?? new Date())}\n`
    return { date, doc, originalBody, initialText, appended: true, existed, originalRaw: raw ?? undefined }
  }
  return { date, doc, originalBody, initialText: originalBody, appended: false, existed, ...(raw != null ? { originalRaw: raw } : {}) }
}

/**
 * 改了又改回去：正文和元数据（不算 updated）都和打开时一样，就返回打开时的文件原文，否则返回 null。
 * 写回原文后文件一字不差，同步时哈希和云端一致，不会再上传；updated 也保持原来的时间。
 */
export function revertedRaw(s: EditSession, body: string): { raw: string; original: EntryDoc } | null {
  if (s.originalRaw == null || s.error) return null
  let original: EntryDoc
  try {
    original = parseEntry(s.originalRaw, s.date)
  } catch {
    return null
  }
  const now: EntryDoc = { ...s.doc, meta: { ...s.doc.meta }, body }
  if (original.meta.updated == null) delete now.meta.updated
  else now.meta.updated = original.meta.updated
  if (original.meta.created == null) delete now.meta.created
  else now.meta.created = original.meta.created
  return serializeEntry(now) === serializeEntry(original) ? { raw: s.originalRaw, original } : null
}

/** 编辑框里的文字对应的正文：只多了一个空的时间标题时，等于原正文。 */
export function bodyFor(s: EditSession, text: string): string {
  if (s.appended && text.trimEnd() === s.initialText.trimEnd()) return s.originalBody
  return text
}
