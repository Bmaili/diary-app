/**
 * 一次编辑会话的规则（规格 4.4 第 5 条、5.2）。
 * - 从“写今天”进入且当天已有内容：在末尾追加 `### HH:mm` 标题，光标放在其后。
 * - 什么都没写就离开：不保留这个空标题。
 */
import type { EntryDoc } from './entryFile'
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
  /** 文件无法解析时为错误信息，编辑页只读显示 */
  error?: string
}

export async function openSession(
  repo: DiaryRepo,
  date: string,
  opts: { append: boolean; now?: Date },
): Promise<EditSession> {
  let doc: EntryDoc | null
  try {
    doc = await repo.readEntry(date)
  } catch (e) {
    const raw = (await repo.readEntryRaw(date)) ?? ''
    return {
      date, doc: { meta: { date }, body: raw, extra: [] },
      originalBody: raw, initialText: raw, appended: false, existed: true,
      error: (e as Error).message,
    }
  }
  const existed = doc != null
  doc ??= { meta: { date }, body: '', extra: [] }
  const originalBody = doc.body
  if (opts.append && existed && hasContent(originalBody)) {
    const initialText = `${originalBody}\n\n### ${hhmm(opts.now ?? new Date())}\n\n`
    return { date, doc, originalBody, initialText, appended: true, existed }
  }
  return { date, doc, originalBody, initialText: originalBody, appended: false, existed }
}

/** 编辑框里的文字对应的正文：只多了一个空的时间标题时，等于原正文。 */
export function bodyFor(s: EditSession, text: string): string {
  if (s.appended && text.trimEnd() === s.initialText.trimEnd()) return s.originalBody
  return text
}
