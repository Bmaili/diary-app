import { afterEach, describe, expect, it } from 'vitest'
import { DiaryRepo, entryPath } from '../src/core/repo'
import { DiaryIndex } from '../src/core/diaryIndex'
import { parseEntry, serializeEntry } from '../src/core/entryFile'
import { DiaryTools } from '../src/core/llm/tools'
import { generateMonthly } from '../src/core/llm/summarize'
import { monthSourceHash } from '../src/core/summaries'
import type { LlmConfig } from '../src/core/llm/client'
import { NodeStore } from './nodeStore'
import { startLlmMock, type LlmMock } from './mocks/llmServer'

let mock: LlmMock | undefined
afterEach(() => mock?.close())

async function setup() {
  const store = await NodeStore.temp()
  const repo = new DiaryRepo(store)
  await repo.init()
  await repo.saveEntry({ meta: { date: '2026-09-01', places: ['老王烧烤'] }, body: '和阿杰吃烧烤。', extra: [] })
  await repo.saveEntry({ meta: { date: '2026-09-02', places: ['老王烧烤'], ai_exclude: true }, body: '这篇是秘密，在老王烧烤。', extra: [] })
  const index = new DiaryIndex(repo, store)
  await index.load()
  return { store, repo, index, tools: new DiaryTools(index, repo, store) }
}

describe('不让 AI 读', () => {
  it('写成 ai_exclude: true；取消后字段消失', () => {
    const doc = parseEntry('---\ndate: 2026-09-02\nai_exclude: true\nmy_field: 1\n---\n\n正文\n')
    expect(doc.meta.ai_exclude).toBe(true)
    expect(serializeEntry(doc)).toBe('---\ndate: 2026-09-02\nai_exclude: true\nmy_field: 1\n---\n\n正文\n')
    delete doc.meta.ai_exclude
    expect(serializeEntry(doc)).toBe('---\ndate: 2026-09-02\nmy_field: 1\n---\n\n正文\n')
  })

  it('问答工具看不到它：统计、计数、搜索、读全文、词表', async () => {
    const { tools } = await setup()
    expect((await tools.run('get_stats', {}) as { total: number }).total).toBe(1)
    expect((await tools.run('count_days', { terms: ['老王烧烤'] }) as { days: number }).days).toBe(1)
    expect((await tools.run('search_entries', { query: '秘密' }) as { total: number }).total).toBe(0)
    expect((await tools.run('get_entries', { dates: ['2026-09-02'] }) as { returned: number }).returned).toBe(0)
    expect((await tools.run('list_values', { field: 'places' }) as { values: { days: number }[] }).values[0].days).toBe(1)
  })

  it('不批量抽取；月度总结不发它，切换后总结变成“源内容已变”', async () => {
    const { repo, index } = await setup()
    expect(index.needsExtraction().map((r) => r.date)).toEqual(['2026-09-01'])
    mock = await startLlmMock(() => ({ text: '总结' }))
    const cfg: LlmConfig = { protocol: 'openai', baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm', apiKey: 'k' }
    const sum = await generateMonthly(cfg, repo, index, '2026-09')
    expect(sum.meta.source_count).toBe(1)
    expect(JSON.stringify(mock.requests[0].body)).not.toContain('秘密')
    const before = await monthSourceHash(index, '2026-09')
    const doc = (await repo.readEntry('2026-09-02'))!
    delete doc.meta.ai_exclude
    await repo.saveEntry(doc)
    await index.refresh('2026-09-02')
    expect((await monthSourceHash(index, '2026-09')).hash).not.toBe(before.hash)
    expect(await repo.store.readText(entryPath('2026-09-02'))).not.toContain('ai_exclude')
  })
})
