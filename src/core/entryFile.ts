/**
 * 日记文件的解析与序列化（规格 4.2–4.4）。
 *
 * 关键约束：未知字段必须原样保留。做法是把 front matter 解析成 YAML 文档节点，
 * 已知字段转成 JS 值供 app 使用，未知字段保留原始节点，写回时原样输出在已知字段之后。
 */
import { Document, isMap, isScalar, parseDocument, Pair, YAMLMap, YAMLSeq } from 'yaml'
import { KNOWN_KEYS, LIST_FIELDS, type EntryMeta, type ListField } from './types'

export class EntryParseError extends Error {}

export interface EntryDoc {
  meta: EntryMeta
  body: string
  /** 原文件中出现的未知字段（保持原始节点与顺序） */
  extra: Pair[]
}

const FM_OPEN = /^---[ \t]*\n/
const FM_CLOSE = /^---[ \t]*$/m

export function normalizeNewlines(s: string): string {
  return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

export function parseEntry(raw: string, fallbackDate?: string): EntryDoc {
  const text = normalizeNewlines(raw)
  if (!FM_OPEN.test(text)) {
    // 没有 front matter：整篇都是正文（例如在其他编辑器里新建的文件）
    if (!fallbackDate) throw new EntryParseError('缺少 front matter，且无法从文件名得到日期')
    return { meta: { date: fallbackDate }, body: trimBody(text), extra: [] }
  }
  const afterOpen = text.replace(FM_OPEN, '')
  const close = FM_CLOSE.exec(afterOpen)
  if (!close) throw new EntryParseError('front matter 没有结束标记 ---')
  const yamlText = afterOpen.slice(0, close.index)
  let rest = afterOpen.slice(close.index + close[0].length)
  rest = rest.replace(/^\n/, '').replace(/^\n/, '')

  const doc = parseDocument(yamlText)
  if (doc.errors.length) throw new EntryParseError('front matter 格式错误：' + doc.errors[0].message)
  const meta: Record<string, unknown> = {}
  const extra: Pair[] = []
  const contents = doc.contents
  if (contents && !isMap(contents)) throw new EntryParseError('front matter 必须是键值对')
  if (contents) {
    for (const item of (contents as YAMLMap).items) {
      const key = isScalar(item.key) ? String(item.key.value) : String(item.key)
      if ((KNOWN_KEYS as readonly string[]).includes(key)) {
        const v = item.value as { toJSON?: () => unknown } | null
        meta[key] = v && typeof v.toJSON === 'function' ? v.toJSON() : (v as unknown)
      } else {
        extra.push(item as Pair)
      }
    }
  }
  const m = coerceMeta(meta, fallbackDate)
  return { meta: m, body: trimBody(rest), extra }
}

function trimBody(s: string): string {
  return s.replace(/\s+$/, '')
}

function strList(v: unknown): string[] | undefined {
  if (v == null) return undefined
  const arr = Array.isArray(v) ? v : [v]
  const out = arr.map((x) => String(x).trim()).filter(Boolean)
  return out.length ? Array.from(new Set(out)) : undefined
}

function coerceMeta(m: Record<string, unknown>, fallbackDate?: string): EntryMeta {
  const date = m.date != null ? String(m.date) : fallbackDate
  if (!date) throw new EntryParseError('缺少 date 字段')
  const out: EntryMeta = { date }
  if (m.created != null) out.created = String(m.created)
  if (m.updated != null) out.updated = String(m.updated)
  if (m.weather && typeof m.weather === 'object') out.weather = m.weather as EntryMeta['weather']
  if (m.mood != null && m.mood !== '') {
    const n = Number(m.mood)
    if (Number.isInteger(n) && n >= 1 && n <= 5) out.mood = n
  }
  if (m.location && typeof m.location === 'object') out.location = m.location as EntryMeta['location']
  for (const f of LIST_FIELDS) {
    const l = strList(m[f])
    if (l) out[f] = l
  }
  if (m.ai && typeof m.ai === 'object') out.ai = m.ai as EntryMeta['ai']
  const locked = strList(m.locked)
  if (locked) out.locked = locked
  if (m.ai_exclude === true || m.ai_exclude === 'true') out.ai_exclude = true
  return out
}

function isEmpty(v: unknown): boolean {
  if (v == null || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.values(v as object).every(isEmpty)
  return false
}

/** 去掉对象里的空值，保证“空字段不写”。 */
function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => !isEmpty(x))
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (!isEmpty(x)) o[k] = prune(x)
    return o
  }
  return v
}

export function serializeEntry(e: EntryDoc): string {
  const doc = new Document()
  const map = new YAMLMap()
  const metaRec = e.meta as unknown as Record<string, unknown>
  for (const key of KNOWN_KEYS) {
    const raw = metaRec[key]
    if (isEmpty(raw) || raw === false) continue
    const value = prune(raw)
    const node = doc.createNode(value) as unknown
    // 与规格示例一致：weather、各列表字段、ai.fields 用行内（flow）写法；location、ai 用块写法
    if (key === 'weather' && isMap(node)) (node as YAMLMap).flow = true
    if (node instanceof YAMLSeq) node.flow = true
    if (key === 'ai' && isMap(node)) {
      const fields = (node as YAMLMap).get('fields', true)
      if (fields instanceof YAMLSeq) fields.flow = true
    }
    map.items.push(new Pair(doc.createNode(key), node))
  }
  for (const p of e.extra) map.items.push(p)
  doc.contents = map as unknown as Document['contents']
  const yamlText = doc.toString({ lineWidth: 0, flowCollectionPadding: false })
  const body = e.body.replace(/\s+$/, '')
  return `---\n${yamlText}---\n\n${body}\n`
}

/** 正文是否为空（规格 4.4 第 8 条：没有内容的日子不生成文件） */
export function hasContent(body: string): boolean {
  return body.replace(/^#{1,6}[ \t]+\d{1,2}:\d{2}[ \t]*$/gm, '').trim().length > 0
}

/**
 * Markdown 正文转纯文本，用于索引与摘要。
 * 同时去掉追加写作时自动生成的 `### HH:mm` 时间标题，避免搜索数字时误命中。
 */
export function plainText(md: string): string {
  return md
    .replace(/^#{1,6}[ \t]+\d{1,2}:\d{2}[ \t]*$/gm, '')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_]/g, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 手动修改列表字段（规格 4.6）：写入新值，把该字段加入 locked，并从 ai.fields 移除。
 * 值没有变化时不做任何事，避免“打开再关掉”就把字段锁住。
 */
export function setListFieldManually(meta: EntryMeta, field: ListField, values: string[]): boolean {
  const next = Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)))
  const prev = meta[field] ?? []
  if (prev.length === next.length && prev.every((v, i) => v === next[i])) return false
  if (next.length) meta[field] = next
  else delete meta[field]
  const locked = new Set(meta.locked ?? [])
  locked.add(field)
  meta.locked = Array.from(locked)
  if (meta.ai?.fields) {
    meta.ai.fields = meta.ai.fields.filter((f) => f !== field)
  }
  return true
}
