/** 编辑页的 AI 标注（单篇抽取，规格 7.3：先显示结果，确认后才写入） */
import { computed, reactive, type Ref } from 'vue'
import { diaryChanged, enqueue, refreshDate, repo } from '../../app'
import { ensureConsent, extractPreview, profileFor } from '../../aiService'
import { applyExtraction, type Extraction } from '../../core/llm/extract'
import type { EditSession } from '../../core/session'

export function useAiExtract(date: string, session: Ref<EditSession | null>, flush: () => Promise<void>, note: (s: string) => void) {
  const canExtract = computed(() => !!profileFor('extract'))
  const ai = reactive({ open: false, busy: false, error: '', x: null as Extraction | null, model: '' })

  async function runExtract() {
    if (ai.busy || !ensureConsent('extract')) return
    await flush()
    if (!session.value?.existed) {
      note('先写点内容再让 AI 标注')
      return
    }
    Object.assign(ai, { open: true, busy: true, error: '', x: null })
    try {
      const r = await extractPreview(date)
      ai.x = r.x
      ai.model = r.model
    } catch (e) {
      ai.error = (e as Error).message
    } finally {
      ai.busy = false
    }
  }

  async function acceptExtract() {
    const s = session.value
    if (!s || !ai.x) return
    applyExtraction(s.doc, ai.x, ai.model)
    await enqueue(async () => {
      await repo.saveEntry(s.doc, new Date(), { touchUpdated: false })
      await refreshDate(date)
    })
    diaryChanged()
    ai.open = false
  }

  return { canExtract, ai, runExtract, acceptExtract }
}
