/**
 * 编辑页快捷按钮与列表续行的文本操作（纯函数，便于测试）。
 * 只插入标准 Markdown 符号，文件仍是纯文本，任何 Markdown 工具都能读。
 * 每个操作返回“把 [from, to) 换成 insert，然后选中 [selStart, selEnd)”，
 * 由界面用 execCommand('insertText') 执行，这样系统自带的撤销仍然有效。
 */

export interface EditState {
  text: string
  start: number
  end: number
}

export interface Edit {
  from: number
  to: number
  insert: string
  selStart: number
  selEnd: number
}

export type LineKind = 'bullet' | 'number' | 'todo' | 'quote'

/** 行首的列表 / 引用标记：缩进、标记本身 */
const PREFIX = /^([ \t]*)(?:([-*+]) \[[ xX]\] |([-*+]) |(\d{1,9})([.)]) |> ?)?/

interface Prefix {
  indent: string
  marker: string
  kind: LineKind | null
  /** 有序列表的序号 */
  n?: number
  delim?: string
  bullet?: string
}

function parsePrefix(line: string): Prefix {
  const m = PREFIX.exec(line)!
  const indent = m[1]
  const marker = m[0].slice(indent.length)
  if (!marker) return { indent, marker: '', kind: null }
  if (m[2]) return { indent, marker, kind: 'todo', bullet: m[2] }
  if (m[3]) return { indent, marker, kind: 'bullet', bullet: m[3] }
  if (m[4]) return { indent, marker, kind: 'number', n: Number(m[4]), delim: m[5] }
  return { indent, marker, kind: 'quote' }
}

function lineBounds(text: string, start: number, end: number): [number, number] {
  const ls = text.lastIndexOf('\n', start - 1) + 1
  // 选区结尾正好在下一行行首时，不算那一行
  const e = end > start && text[end - 1] === '\n' ? end - 1 : end
  const nl = text.indexOf('\n', e)
  return [ls, nl < 0 ? text.length : nl]
}

/** 加粗（或其他成对符号）：没选中时插入一对并把光标放中间；已经加粗的再点一次去掉 */
export function toggleWrap(s: EditState, mark = '**'): Edit {
  const { text, start, end } = s
  const k = mark.length
  if (start === end) {
    if (text.slice(start - k, start) === mark && text.slice(start, start + k) === mark) {
      return { from: start - k, to: start + k, insert: '', selStart: start - k, selEnd: start - k }
    }
    return { from: start, to: end, insert: mark + mark, selStart: start + k, selEnd: start + k }
  }
  const sel = text.slice(start, end)
  // 选中的内容两边已经有符号：去掉
  if (sel.length >= 2 * k && sel.startsWith(mark) && sel.endsWith(mark)) {
    const inner = sel.slice(k, -k)
    return { from: start, to: end, insert: inner, selStart: start, selEnd: start + inner.length }
  }
  if (text.slice(start - k, start) === mark && text.slice(end, end + k) === mark) {
    return { from: start - k, to: end + k, insert: sel, selStart: start - k, selEnd: end - k }
  }
  // 跨行时逐行加粗（Markdown 的加粗不能跨段落）；首尾空白留在符号外面，否则不生效
  const out = sel
    .split('\n')
    .map((line) => {
      const m = /^(\s*)(.*?)(\s*)$/.exec(line)!
      return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : line
    })
    .join('\n')
  return { from: start, to: end, insert: out, selStart: start, selEnd: start + out.length }
}

function prefixFor(kind: LineKind, i: number, bullet = '-'): string {
  switch (kind) {
    case 'bullet': return `${bullet} `
    case 'number': return `${i + 1}. `
    case 'todo': return `${bullet} [ ] `
    case 'quote': return '> '
  }
}

/** 列表、编号、待办、引用：对选中的每一行切换；已经全是这种就去掉，是别的种类就换成这种 */
export function toggleLines(s: EditState, kind: LineKind): Edit {
  const { text, start, end } = s
  const [ls, le] = lineBounds(text, start, end)
  const lines = text.slice(ls, le).split('\n')
  const parsed = lines.map(parsePrefix)
  const target = lines.map((l, i) => ({ l, p: parsed[i] })).filter((x) => lines.length === 1 || x.l.trim())
  const allSame = target.length > 0 && target.every((x) => x.p.kind === kind)
  let n = 0
  const out = lines.map((line, i) => {
    const p = parsed[i]
    const rest = line.slice(p.indent.length + p.marker.length)
    if (lines.length > 1 && !line.trim()) return line
    if (allSame) return p.indent + rest
    return p.indent + prefixFor(kind, n++, p.bullet) + rest
  })
  const insert = out.join('\n')
  if (start === end && lines.length === 1) {
    // 光标跟着正文走
    const p = parsed[0]
    const oldPre = p.indent.length + p.marker.length
    const newPre = insert.length - (lines[0].length - oldPre)
    const col = Math.max(start - ls - oldPre, 0)
    const pos = ls + newPre + col
    return { from: ls, to: le, insert, selStart: pos, selEnd: pos }
  }
  return { from: ls, to: le, insert, selStart: ls, selEnd: ls + insert.length }
}

/**
 * 在列表里按回车：自动接上下一项的标记。空的一项上再按回车，结束列表（去掉标记，不换行）。
 * 不在列表里、或者光标在标记中间时返回 null，交给系统正常换行。
 */
export function continueList(s: EditState): Edit | null {
  const { text, start, end } = s
  if (start !== end) return null
  const ls = text.lastIndexOf('\n', start - 1) + 1
  const nl = text.indexOf('\n', start)
  const line = text.slice(ls, nl < 0 ? text.length : nl)
  const p = parsePrefix(line)
  if (!p.kind) return null
  const preLen = p.indent.length + p.marker.length
  if (start - ls < preLen) return null
  if (!line.slice(preLen).trim()) {
    // 空的一项：结束列表。上面还有列表项时留一个空行，否则 Markdown 会把下一段接进最后一项里
    const prev = ls > 0 ? text.slice(text.lastIndexOf('\n', ls - 2) + 1, ls - 1) : ''
    const insert = parsePrefix(prev).kind && prev.trim() ? '\n' : ''
    const pos = ls + insert.length
    return { from: ls, to: ls + line.length, insert, selStart: pos, selEnd: pos }
  }
  let next: string
  switch (p.kind) {
    case 'bullet': next = `${p.bullet} `; break
    case 'todo': next = `${p.bullet} [ ] `; break
    case 'number': next = `${(p.n ?? 0) + 1}${p.delim} `; break
    default: next = '> '
  }
  const insert = `\n${p.indent}${next}`
  // 光标后面的文字会被带到新的一行，去掉它前面的空格
  const after = text.slice(start, nl < 0 ? text.length : nl)
  const trim = after.length - after.trimStart().length
  const pos = start + insert.length
  return { from: start, to: start + trim, insert, selStart: pos, selEnd: pos }
}

/** 在光标处插入文字（替换选中内容） */
export function insertAt(s: EditState, str: string): Edit {
  const pos = s.start + str.length
  return { from: s.start, to: s.end, insert: str, selStart: pos, selEnd: pos }
}

/** 应用一个编辑（测试用；界面里由 execCommand 完成） */
export function apply(text: string, e: Edit): string {
  return text.slice(0, e.from) + e.insert + text.slice(e.to)
}

const TASK = /^([ \t]*[-*+] \[)([ xX])(\] )/

/** 阅读视图里勾选第 index 个待办：改写正文里对应的 [ ] / [x]。跳过代码块里的。 */
export function toggleTask(text: string, index: number, checked: boolean): string | null {
  const lines = text.split('\n')
  let fence = false
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    if (/^[ \t]*(```|~~~)/.test(lines[i])) fence = !fence
    if (fence) continue
    const m = TASK.exec(lines[i])
    if (!m) continue
    if (n++ === index) {
      lines[i] = lines[i].replace(TASK, `$1${checked ? 'x' : ' '}$3`)
      return lines.join('\n')
    }
  }
  return null
}
