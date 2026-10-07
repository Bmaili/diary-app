import { describe, expect, it } from 'vitest'
import { apply, continueList, insertAt, insertHeading, toggleLines, toggleTask, toggleWrap, type Edit, type EditState } from '../src/core/mdEdit'

/** 用 | 表示光标，[ ] 之间表示选区 */
function st(src: string): EditState {
  const a = src.indexOf('⟦')
  if (a >= 0) {
    const b = src.indexOf('⟧')
    return { text: src.replace('⟦', '').replace('⟧', ''), start: a, end: b - 1 }
  }
  const c = src.indexOf('|')
  return { text: src.replace('|', ''), start: c, end: c }
}
function show(s: EditState, e: Edit | null): string {
  if (!e) return 'null'
  const t = apply(s.text, e)
  if (e.selStart === e.selEnd) return t.slice(0, e.selStart) + '|' + t.slice(e.selStart)
  return t.slice(0, e.selStart) + '⟦' + t.slice(e.selStart, e.selEnd) + '⟧' + t.slice(e.selEnd)
}
const run = (src: string, f: (s: EditState) => Edit | null) => {
  const s = st(src)
  return show(s, f(s))
}

describe('加粗', () => {
  it('没选中：插入一对，光标在中间；再点一次去掉', () => {
    expect(run('今天|', toggleWrap)).toBe('今天**|**')
    expect(run('今天**|**', toggleWrap)).toBe('今天|')
  })
  it('选中文字：加粗，再点去掉', () => {
    expect(run('看到⟦木星⟧了', toggleWrap)).toBe('看到⟦**木星**⟧了')
    expect(run('看到⟦**木星**⟧了', toggleWrap)).toBe('看到⟦木星⟧了')
    expect(run('看到**⟦木星⟧**了', toggleWrap)).toBe('看到⟦木星⟧了')
  })
  it('首尾空白留在外面；跨行逐行加粗', () => {
    expect(run('⟦ 木星 ⟧', toggleWrap)).toBe('⟦ **木星** ⟧')
    expect(run('⟦第一行\n\n第二行⟧', toggleWrap)).toBe('⟦**第一行**\n\n**第二行**⟧')
  })
})

describe('列表、编号、待办、引用', () => {
  it('单行切换，光标跟着正文', () => {
    expect(run('买|菜', (s) => toggleLines(s, 'bullet'))).toBe('- 买|菜')
    expect(run('- 买|菜', (s) => toggleLines(s, 'bullet'))).toBe('买|菜')
    expect(run('- 买|菜', (s) => toggleLines(s, 'todo'))).toBe('- [ ] 买|菜')
    expect(run('- [ ] 买|菜', (s) => toggleLines(s, 'number'))).toBe('1. 买|菜')
    expect(run('一句|话', (s) => toggleLines(s, 'quote'))).toBe('> 一句|话')
  })
  it('空行上点：插入标记', () => {
    expect(run('第一段\n|', (s) => toggleLines(s, 'todo'))).toBe('第一段\n- [ ] |')
  })
  it('多行：逐行编号，跳过空行；再点去掉', () => {
    expect(run('⟦起床\n跑步\n\n读书⟧', (s) => toggleLines(s, 'number'))).toBe('⟦1. 起床\n2. 跑步\n\n3. 读书⟧')
    expect(run('⟦1. 起床\n2. 跑步⟧', (s) => toggleLines(s, 'number'))).toBe('⟦起床\n跑步⟧')
  })
  it('保留缩进', () => {
    expect(run('  子|项', (s) => toggleLines(s, 'bullet'))).toBe('  - 子|项')
  })
  it('不影响选区外的行', () => {
    expect(run('上一行\n这|行\n下一行', (s) => toggleLines(s, 'bullet'))).toBe('上一行\n- 这|行\n下一行')
  })
})

describe('回车续行', () => {
  it('无序、待办、编号、引用', () => {
    expect(run('- 买菜|', continueList)).toBe('- 买菜\n- |')
    expect(run('* 买菜|', continueList)).toBe('* 买菜\n* |')
    expect(run('- [x] 买菜|', continueList)).toBe('- [x] 买菜\n- [ ] |')
    expect(run('9. 第九|', continueList)).toBe('9. 第九\n10. |')
    expect(run('1) 第一|', continueList)).toBe('1) 第一\n2) |')
    expect(run('> 引用|', continueList)).toBe('> 引用\n> |')
    expect(run('  - 子项|', continueList)).toBe('  - 子项\n  - |')
  })
  it('空的一项上回车：结束列表', () => {
    // 留一个空行，下一段才不会被并进最后一项
    expect(run('- 买菜\n- |', continueList)).toBe('- 买菜\n\n|')
    expect(run('1. a\n2. |', continueList)).toBe('1. a\n\n|')
    expect(run('- 买菜\n- |\n后面的', continueList)).toBe('- 买菜\n\n|\n后面的')
    // 上面不是列表：只去掉标记
    expect(run('- [ ] |', continueList)).toBe('|')
    expect(run('一段话\n- |', continueList)).toBe('一段话\n|')
  })
  it('光标在行中间：后半句带到新的一项', () => {
    expect(run('- 买菜| 和水果', continueList)).toBe('- 买菜\n- |和水果')
  })
  it('普通段落、选区、光标在标记里：交给系统', () => {
    expect(continueList(st('普通的一句|'))).toBeNull()
    expect(continueList(st('-| 买菜'))).toBeNull()
    expect(continueList(st('- ⟦买⟧菜'))).toBeNull()
    expect(continueList(st('---|'))).toBeNull()
    expect(continueList(st('*斜体*|'))).toBeNull()
  })
})

describe('其他', () => {
  it('插入时间替换选区', () => {
    expect(run('今天⟦xx⟧', (s) => insertAt(s, '21:30 '))).toBe('今天21:30 |')
  })
  it('时间按钮插入 ### HH:mm 标题：单独一行，前面空一行，光标在下一行', () => {
    const h = (s: EditState) => insertHeading(s, '21:30')
    expect(run('|', h)).toBe('### 21:30\n|')
    expect(run('上午写的。|', h)).toBe('上午写的。\n\n### 21:30\n|')
    expect(run('上午写的。\n|', h)).toBe('上午写的。\n\n### 21:30\n|')
    expect(run('上午写的。\n\n|', h)).toBe('上午写的。\n\n### 21:30\n|')
    expect(run('上午|写的。', h)).toBe('上午\n\n### 21:30\n|写的。')
    expect(run('  \n|', h)).toBe('### 21:30\n|')
  })
  it('勾选待办：按顺序找第 n 个，跳过代码块', () => {
    const t = '- [ ] 买菜\n```\n- [ ] 代码里的\n```\n* [ ] 看星星'
    expect(toggleTask(t, 0, true)).toBe('- [x] 买菜\n```\n- [ ] 代码里的\n```\n* [ ] 看星星')
    expect(toggleTask(t, 1, true)).toBe('- [ ] 买菜\n```\n- [ ] 代码里的\n```\n* [x] 看星星')
    expect(toggleTask('- [X] a', 0, false)).toBe('- [ ] a')
    expect(toggleTask(t, 5, true)).toBeNull()
  })
})
