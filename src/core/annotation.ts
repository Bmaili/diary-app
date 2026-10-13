/**
 * 朱批（2026-10-13 加入，规格 4.9、5.16）：用户在阅读视图里点“请批”，AI 读这一篇，在页边写一两句批语。
 *
 * 一天一个文件：diary/annotations/YYYY/YYYY-MM-DD.md，YAML front matter 加批语正文。
 *
 * ```
 * ---
 * date: 2026-10-09
 * created: 2026-10-13T21:05:00+08:00
 * model: qwen-plus
 * ---
 *
 * 会上说不出的话，夜里都改进了方案里。
 * ```
 *
 * - 只在用户点了才写，不自动触发；“换一句”覆盖，“删去”删掉文件（批语是 AI 写的，随时可以再请）。
 * - 不进日记索引，问答、搜索、总结都读不到它。删除日记时一起移到最近删除。
 * - 未知字段原样保留。
 */
import { Document, isMap, isScalar, parseDocument, Pair, YAMLMap } from 'yaml'
import { ROOT } from './repo'
import { normalizeNewlines, plainText, type EntryDoc } from './entryFile'
import { weekday } from './time'

export const ANNOTATIONS = `${ROOT}/annotations`

export const annotationPath = (date: string) => `${ANNOTATIONS}/${date.slice(0, 4)}/${date}.md`
/** 相对 diary/ 的路径（最近删除、导入用） */
export const annotationRel = (date: string) => annotationPath(date).slice(ROOT.length + 1)

export interface Annotation {
  date: string
  /** 写下批语的时间，ISO 8601 带时区 */
  created: string
  /** 用的哪个模型（只是记一下） */
  model?: string
  text: string
  extra: Pair[]
}

const KEYS = ['date', 'created', 'model'] as const

export function parseAnnotation(raw: string, date: string): Annotation {
  const text = normalizeNewlines(raw)
  const m = /^---[ \t]*\n([\s\S]*?)\n?^---[ \t]*$/m.exec(text)
  const meta: Record<string, unknown> = {}
  const extra: Pair[] = []
  let body = text
  if (m && m.index === 0) {
    const doc = parseDocument(m[1])
    if (doc.errors.length || (doc.contents && !isMap(doc.contents))) throw new Error('批语文件的开头格式不对')
    for (const item of (doc.contents as YAMLMap | null)?.items ?? []) {
      const key = isScalar(item.key) ? String(item.key.value) : String(item.key)
      const v = item.value as { toJSON?: () => unknown } | null
      if ((KEYS as readonly string[]).includes(key)) meta[key] = v && typeof v.toJSON === 'function' ? v.toJSON() : v
      else extra.push(item as Pair)
    }
    body = text.slice(m[0].length)
  }
  return {
    date,
    created: meta.created == null ? '' : String(meta.created),
    ...(meta.model ? { model: String(meta.model) } : {}),
    text: body.trim(),
    extra,
  }
}

export function serializeAnnotation(a: Annotation): string {
  const doc = new Document()
  const map = new YAMLMap()
  const vals: Record<string, unknown> = { date: a.date, created: a.created, model: a.model }
  for (const k of KEYS) {
    const v = vals[k]
    if (v == null || v === '') continue
    map.items.push(new Pair(doc.createNode(k), doc.createNode(v)))
  }
  for (const p of a.extra) map.items.push(p)
  doc.contents = map as unknown as Document['contents']
  return `---\n${doc.toString({ lineWidth: 0 })}---\n\n${a.text.trim()}\n`
}

/** 批语最长多少字（固定部分要求 60 字以内，这里留点余地，超了截到句末） */
export const ANNOTATION_MAX = 80

/** 模型输出 → 批语：去掉引号、Markdown 记号、署名、多余的空白，太长截到最后一个句号 */
export function cleanAnnotation(s: string): string {
  let t = s
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^\s*(批语|朱批|批)[:：]\s*/, '')
    .replace(/[*_#>`~]/g, '')
    .replace(/\s*\n+\s*/g, '')
    .replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/g, '')
    .replace(/\s*[—-]{1,2}\s*[^。！？\s]{1,8}$/, '')
    .trim()
  if (t.length > ANNOTATION_MAX) {
    const cut = t.slice(0, ANNOTATION_MAX)
    const end = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'))
    t = end >= 10 ? cut.slice(0, end + 1) : `${cut}…`
  }
  return t
}

const MOODS = ['很差', '不好', '一般', '不错', '很好']
/** 发给模型的正文最多这么多字：批语只需要读个大概 */
const BODY_MAX = 6000

/** 请批时的用户消息：日期、心情、天气、地点，加正文（图片换成说明文字） */
export function annotationPrompt(doc: EntryDoc, avoid?: string): string {
  const m = doc.meta
  const lines = [`日期：${m.date}（${weekday(m.date)}）`]
  if (m.mood != null && MOODS[m.mood - 1]) lines.push(`心情：${MOODS[m.mood - 1]}`)
  if (m.weather?.text) lines.push(`天气：${m.weather.text}`)
  const place = m.location?.name || m.places?.[0]
  if (place) lines.push(`地点：${place}`)
  let body = plainText(doc.body.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => (alt.trim() ? `（照片：${alt.trim()}）` : '（照片）'))).trim()
  if (body.length > BODY_MAX) body = `${body.slice(0, BODY_MAX)}\n（后面还有，略）`
  lines.push('', '日记：', body)
  if (avoid?.trim()) lines.push('', `上次的批语是“${avoid.trim()}”。换一句不同的，不要重复它的意思和说法。`)
  return lines.join('\n')
}
