<script setup lang="ts">
/**
 * 图片说明（2026-10-05 加入）：给一张插图写一句话，存成 Markdown 的替代文字 ![说明](路径)。
 * 可以让 AI 看图写一句（需要能看图的模型）；设置里开了“插图后让 AI 写一句说明”时打开就自动写。
 * 点“完成”或点空白处关闭都会保存。AI 还没写完就关了：写好后只在这张图还没有说明时填进去。
 */
import { ref, watch } from 'vue'
import Sheet from './Sheet.vue'
import Icon from './Icon.vue'
import { imageUrl } from '../../imageService'
import { captionPreview, ensureConsent } from '../../aiService'

const props = defineProps<{
  open: boolean
  date: string
  src: string
  current: string
  /** 这篇日记的正文，给 AI 作参考 */
  excerpt: () => string
  /** 可以用 AI（配了服务、这篇没有设为不让 AI 读） */
  canAi: boolean
  /** 打开时自动让 AI 写 */
  auto: boolean
}>()
const emit = defineEmits<{ close: []; save: [string]; late: [src: string, alt: string] }>()

const draft = ref('')
const url = ref('')
const busy = ref(false)
const err = ref('')
let ticket = 0

watch(
  () => props.open,
  async (o) => {
    if (!o) return
    draft.value = props.current
    err.value = ''
    url.value = ''
    url.value = await imageUrl(props.src).catch(() => '')
    if (props.auto && props.canAi && !props.current) void runAi(true)
  },
)

async function runAi(auto = false) {
  if (busy.value || !props.canAi) return
  if (!ensureConsent('caption')) return
  const my = ++ticket
  const src = props.src
  busy.value = true
  err.value = ''
  try {
    const t = await captionPreview(props.date, src, props.excerpt())
    if (my !== ticket) return
    if (props.open) {
      // 自动写的时候用户已经开始打字，就不覆盖
      if (!(auto && draft.value.trim())) draft.value = t
    } else emit('late', src, t)
  } catch (e) {
    if (my === ticket && props.open) err.value = (e as Error).message
  } finally {
    if (my === ticket) busy.value = false
  }
}

function onEnter(e: KeyboardEvent) {
  if (!e.isComposing) done()
}

function done() {
  emit('save', draft.value)
  emit('close')
}
</script>

<template>
  <Sheet :open="open" title="图片说明" @close="done">
    <div class="pic" :class="{ busy }">
      <img v-if="url" :src="url" alt="" />
    </div>
    <input v-model="draft" class="field" maxlength="80" placeholder="一句话说说这张图（可以不写）" aria-label="图片说明" @keydown.enter="onEnter" />
    <button v-if="canAi" class="chip add ai" :disabled="busy" @click="runAi()">
      <Icon name="sparkle" class="ci" />{{ busy ? 'AI 正在看图…' : draft ? '让 AI 重写一句' : 'AI 看图写一句' }}
    </button>
    <p v-if="err" class="err">{{ err }}</p>
    <p class="hint">说明显示在图片下面，AI 问答和总结也能读到它。点“完成”保存，清空就是不要说明。</p>
  </Sheet>
</template>

<style scoped>
.pic {
  display: flex;
  justify-content: center;
  min-height: 80px;
  margin-bottom: 12px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface);
}
.pic img { display: block; max-width: 100%; max-height: 32vh; object-fit: contain; }
.pic.busy img { animation: breathe 1.6s ease-in-out infinite; }
@keyframes breathe { 50% { opacity: 0.6; } }
.ai { margin-top: 12px; }
.ci { width: 16px; height: 16px; }
.hint { margin: 10px 0 0; font-size: 12px; color: var(--faint); }
.err { margin: 10px 0 0; font-size: 13px; color: var(--danger); }
</style>
