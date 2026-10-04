import { describe, expect, it } from 'vitest'
import {
  EntryParseError, hasContent, parseEntry, plainText, serializeEntry, setListFieldManually,
} from '../src/core/entryFile'

// 规格 4.2 的示例（lat/lng 去掉了无意义的末尾 0，YAML 数字不保留它们）
const SPEC_EXAMPLE = `---
date: 2026-09-30
created: 2026-09-30T21:14:03+08:00
updated: 2026-09-30T22:40:11+08:00
weather: {text: 晴, temp_c: 28}
mood: 4
location:
  name: 某某餐厅
  address: 广州市天河区……
  lat: 23.1291
  lng: 113.2644
  crs: wgs84
  amap_poi_id: B00140XXXX
tags: [聚餐]
people: [小王]
places: [某某餐厅]
ai:
  extracted_at: 2026-10-01T09:00:00+08:00
  model: deepseek-chat
  fields: [people, places]
locked: [tags]
---

和小王去了某某餐厅……

### 22:40

同一天第二次写的内容追加在这里。
`

describe('日记文件格式（规格 4.2–4.4）', () => {
  it('规格示例解析后再写出，逐字节不变', () => {
    const doc = parseEntry(SPEC_EXAMPLE)
    expect(doc.meta.mood).toBe(4)
    expect(doc.meta.location?.lat).toBe(23.1291)
    expect(doc.meta.tags).toEqual(['聚餐'])
    expect(serializeEntry(doc)).toBe(SPEC_EXAMPLE)
  })

  it('未知字段原样保留，并排在已知字段之后', () => {
    const raw = `---
custom_rating: 9
date: 2026-10-01
source:
  app: 其他日记软件
  id: "00123"
mood: 3
---

正文
`
    const doc = parseEntry(raw)
    doc.body += '\n\n新加的一句。'
    doc.meta.mood = 5
    const out = serializeEntry(doc)
    expect(out).toBe(`---
date: 2026-10-01
mood: 5
custom_rating: 9
source:
  app: 其他日记软件
  id: "00123"
---

正文

新加的一句。
`)
    // 再读一遍，未知字段的值不变（"00123" 仍是字符串）
    const again = parseEntry(out)
    expect(again.extra.map((p) => String((p.key as any).value))).toEqual(['custom_rating', 'source'])
    expect((again.extra[1].value as any).toJSON()).toEqual({ app: '其他日记软件', id: '00123' })
  })

  it('空字段不写；UTF-8 无 BOM、LF 换行', () => {
    const doc = parseEntry('﻿---\r\ndate: 2026-10-02\r\ntags: []\r\nweather: {}\r\n---\r\n\r\n你好\r\n')
    const out = serializeEntry(doc)
    expect(out).toBe('---\ndate: 2026-10-02\n---\n\n你好\n')
    expect(out.includes('\r')).toBe(false)
    expect(out.charCodeAt(0)).not.toBe(0xfeff)
  })

  it('没有 front matter 的文件按正文处理，日期取自文件名', () => {
    const doc = parseEntry('只有正文\n', '2026-10-03')
    expect(doc.meta.date).toBe('2026-10-03')
    expect(serializeEntry(doc)).toBe('---\ndate: 2026-10-03\n---\n\n只有正文\n')
  })

  it('front matter 损坏时报错，而不是静默丢数据', () => {
    expect(() => parseEntry('---\ndate: [2026\n---\n\nx')).toThrow(EntryParseError)
    expect(() => parseEntry('---\ndate: 2026-10-01\n\n正文没有结束标记')).toThrow(EntryParseError)
  })

  it('只有空时间标题时视为没有内容', () => {
    expect(hasContent('### 22:40\n\n')).toBe(false)
    expect(hasContent('   \n')).toBe(false)
    expect(hasContent('一句话')).toBe(true)
  })

  it('纯文本提取去掉 Markdown 记号和时间标题', () => {
    expect(plainText('**加粗** 和 [链接](http://x)\n\n### 22:40\n\n- 列表项\n> 引用')).toBe(
      '加粗 和 链接\n\n列表项\n引用',
    )
  })
})

describe('手动修改即锁定（规格 4.6）', () => {
  it('改了字段：写入新值、加入 locked、从 ai.fields 移除', () => {
    const doc = parseEntry(SPEC_EXAMPLE)
    expect(setListFieldManually(doc.meta, 'people', ['小王', '阿杰'])).toBe(true)
    expect(doc.meta.people).toEqual(['小王', '阿杰'])
    expect(doc.meta.locked).toEqual(['tags', 'people'])
    expect(doc.meta.ai?.fields).toEqual(['places'])
  })

  it('值没变时不锁定', () => {
    const doc = parseEntry('---\ndate: 2026-10-01\ntags: [读书]\n---\n\nx\n')
    expect(setListFieldManually(doc.meta, 'tags', ['读书'])).toBe(false)
    expect(doc.meta.locked).toBeUndefined()
  })

  it('清空字段后不写该字段，但保持锁定', () => {
    const doc = parseEntry('---\ndate: 2026-10-01\ntags: [读书]\n---\n\nx\n')
    setListFieldManually(doc.meta, 'tags', [])
    expect(serializeEntry(doc)).toBe('---\ndate: 2026-10-01\nlocked: [tags]\n---\n\nx\n')
  })
})
