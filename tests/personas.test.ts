/** 灯下的人物、问候、接着问（2026-10-19） */
import { describe, expect, it } from 'vitest'
import { nextQuestions, plainDay, splitRelated, splitTail } from '../src/core/answer'
import { allPersonas, cleanCustom, greetingLines, greetSlot, personaBlock, personaById, PERSONAS, STYLE_MAX } from '../src/core/llm/personas'
import { pickGreeting } from '../src/core/greeting'
import { allLines, seasonalLines } from '../src/core/hints'
import { moodWord } from '../src/core/llm/tools'

describe('回答末尾的两行', () => {
  const md = '那天你们去了海边。\n\n相关日期：2026-09-08、2026-10-03\n接着问：后来还去过吗？｜第一次去是什么时候？'
  it('拆出相关日期和接着问，先后不限', () => {
    expect(splitTail(md)).toEqual({ body: '那天你们去了海边。', dates: ['2026-09-08', '2026-10-03'], next: ['后来还去过吗？', '第一次去是什么时候？'] })
    const swapped = '好。\n接着问：“A 问题”｜B 问题\n相关日期：2026-01-02'
    expect(splitTail(swapped)).toEqual({ body: '好。', dates: ['2026-01-02'], next: ['A 问题', 'B 问题'] })
    expect(splitRelated(md)).toEqual({ body: '那天你们去了海边。', dates: ['2026-09-08', '2026-10-03'] })
    expect(nextQuestions('**接着问**：一｜二二｜三三三｜四四四四')).toEqual(['二二', '三三三', '四四四四'])
  })
  it('接着问是用户问 AI 的：有“你”没“我”的（AI 在问用户）不显示', () => {
    expect(nextQuestions('好。\n接着问：你后来还去过吗？｜我第一次去西湖是什么时候？｜那天你开心吗？｜外婆家的桂树还开吗？'))
      .toEqual(['我第一次去西湖是什么时候？', '外婆家的桂树还开吗？'])
    expect(nextQuestions('好。\n接着问：你还记得我第一次去海边吗？')).toEqual(['你还记得我第一次去海边吗？'])
  })
  it('不在末尾的不动；流式输出时写到一半的那行先藏起来', () => {
    expect(splitTail('接着问：甲甲｜乙乙\n后面还有话').next).toEqual([])
    expect(splitTail('你好。\n接着', true).body).toBe('你好。')
    expect(splitTail('你好。\n相关日', true).body).toBe('你好。')
    expect(splitTail('你好。\n接着', false).body).toBe('你好。\n接着')
  })
  it('日期显示成“10月12日”，不是今年的带年份', () => {
    expect(plainDay('2026-10-12', '2026')).toBe('10月12日')
    expect(plainDay('2025-01-05', '2026')).toBe('2025年1月5日')
  })
})

describe('人物', () => {
  it('六个内置人物，老友是默认；找不到时用老友', () => {
    expect(PERSONAS.map((p) => p.name)).toEqual(['老友', '知音', '说书人', '损友', '元气同桌', '猫'])
    expect(personaById('nope').id).toBe('friend')
    expect(personaById(undefined).name).toBe('老友')
  })
  it('自定义人物：名字和说话的样子都要有，截到上限；排在内置的后面', () => {
    expect(cleanCustom({ id: 'u1', name: '  ', style: '慢慢说' })).toBeNull()
    expect(cleanCustom({ id: 'u1', name: '外婆', style: '' })).toBeNull()
    const c = cleanCustom({ id: 'u1', name: '外婆外婆外婆外婆外婆', style: '叫我乖乖'.repeat(100), example: ' ' })!
    expect(c.name).toHaveLength(8)
    expect(c.style).toHaveLength(300)
    expect(c.example).toBeUndefined()
    const all = allPersonas([c])
    expect(all[all.length - 1]).toMatchObject({ id: 'u1', custom: true })
    expect(personaById('u1', [c]).name).toBe('外婆外婆外婆外婆')
  })
  it('人物一节写明身份语气以它为准', () => {
    const b = personaBlock(personaById('cat'))
    expect(b).toContain('## 这次陪他聊的是：猫')
    expect(b).toContain('身份和语气以这一节为准')
  })
  it('内置人物：设定能照着改（不超过上限），各有心情不好时的陪法和两三段示范问答', () => {
    for (const p of PERSONAS) {
      expect(p.style.length).toBeLessThanOrEqual(STYLE_MAX)
      expect(p.low).toBeTruthy()
      expect(p.samples!.length).toBeGreaterThanOrEqual(2)
      const b = personaBlock(p)
      expect(b).toContain(p.samples![0].a)
      expect(b).toContain(p.low!)
      expect(b).toContain('虚构的')
      // 示范里不写具体日期，免得被当成他的日记
      for (const s of p.samples!) expect(s.a).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    }
    expect(personaBlock(personaById('cat'))).toContain('铲屎的')
  })
  it('自定义人物没有示范，用例句', () => {
    const c = cleanCustom({ id: 'u2', name: '外婆', style: '叫我乖乖', example: '乖乖，吃饭了没有？' })!
    const b = personaBlock(personaById('u2', [c]))
    expect(b).toContain('说话大概是这个味道：“乖乖，吃饭了没有？”')
    expect(b).not.toContain('说话的样子（下面的人和事是虚构的')
  })
  it('每个内置人物每个时段都有问候；时段归并', () => {
    for (const p of PERSONAS) for (const s of ['morning', 'day', 'evening', 'night'] as const) expect(greetingLines(p.id, s).length).toBeGreaterThan(1)
    expect(['dawn', 'morning', 'afternoon', 'dusk', 'night', 'late'].map(greetSlot)).toEqual(['morning', 'morning', 'day', 'evening', 'evening', 'night'])
  })
})

describe('问候', () => {
  const now = new Date(2026, 9, 19, 21, 30)
  it('同一个种子同一句；换了人物会换；不和首页那句重复', () => {
    const c = { persona: 'friend', date: '2026-10-19', now, seed: 's1' }
    expect(pickGreeting(c)).toBe(pickGreeting(c))
    const lines = new Set(Array.from({ length: 40 }, (_, i) => pickGreeting({ ...c, seed: `s${i}` })))
    expect(lines.size).toBeGreaterThan(4)
    const first = pickGreeting(c)
    for (let i = 0; i < 40; i++) expect(pickGreeting({ ...c, seed: `s${i}`, avoid: first })).not.toBe(first)
  })
  it('自定义人物没有自己的问候，就用节令和日记里的句子', () => {
    const personal = ['两年前的今天，你在西湖。']
    const seen = new Set(Array.from({ length: 60 }, (_, i) => pickGreeting({ persona: 'u1', date: '2026-10-19', now, seed: `x${i}`, personal })))
    for (const t of seen) expect([...seasonalLines('2026-10-19', now), ...personal]).toContain(t)
  })
  it('节令句子里没有催人写日记的话', () => {
    for (const d of ['2026-10-23', '2026-09-25', '2027-02-17', '2026-12-22']) {
      for (const h of [6, 14, 19, 23]) for (const t of seasonalLines(d, new Date(`${d}T${String(h).padStart(2, '0')}:10:00`))) expect(t).not.toMatch(/写|记|笔/)
    }
    expect(allLines().length).toBeGreaterThan(50)
  })
})

describe('心情交给模型时用文字', () => {
  it('1–5 换成很差到很好', () => {
    expect([1, 2, 3, 4, 5].map(moodWord)).toEqual(['很差', '不好', '一般', '不错', '很好'])
    expect(moodWord(undefined)).toBeUndefined()
    expect(moodWord(null)).toBeUndefined()
  })
})
