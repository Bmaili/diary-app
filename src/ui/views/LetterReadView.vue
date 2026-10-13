<script setup lang="ts">
/** 读一封信（规格 5.13）：到了的第一次打开时记下拆信时间；没到的不给看 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { today } from '../../app'
import { daysUntil, letterState, type Letter } from '../../core/letters'
import { parseYmd } from '../../core/time'
import { lunar } from '../../holidayService'
import { letters, openLetter, reloadLetters, trashLetterById } from '../../lettersService'
import { renderMarkdown } from '../markdown'
import Icon from '../components/Icon.vue'
import { ask } from '../dialog'

const route = useRoute()
const router = useRouter()
const id = String(route.params.id)
const letter = ref<Letter | null>(null)
const sealed = ref<Letter | null>(null)
const err = ref('')

onMounted(async () => {
  if (!letters.loaded) await reloadLetters()
  const l = letters.list.find((x) => x.id === id)
  if (!l) {
    err.value = '找不到这封信，可能已经删除了。'
    return
  }
  if (letterState(l, today()) === 'sealed') {
    sealed.value = l
    return
  }
  try {
    letter.value = await openLetter(id)
  } catch (e) {
    err.value = (e as Error).message
  }
})

const writtenOn = computed(() => {
  const w = id.slice(0, 10)
  const d = parseYmd(w)
  const l = lunar(w)
  return `写于 ${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日${l.jieqi ? ` · ${l.jieqi}` : ''}`
})
const html = computed(() => (letter.value ? renderMarkdown(letter.value.body) : ''))

async function remove() {
  if (!letter.value) return
  const ok = await ask({ title: '删除这封信？', message: '会移到“设置 → 最近删除”，保留 30 天，可以恢复。', ok: '删除', danger: true })
  if (!ok) return
  await trashLetterById(id)
  router.replace('/letters')
}

function goBack() {
  if (window.history.state?.back) router.back()
  else router.replace('/letters')
}
</script>

<template>
  <div class="read-letter">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="goBack"><Icon name="back" /></button>
      <h1>一封信</h1>
      <button v-if="letter" class="icon-btn trash" aria-label="删除这封信" @click="remove"><Icon name="trash" /></button>
    </header>

    <p v-if="err" class="result bad pad">{{ err }}</p>

    <div v-if="sealed" class="sealed">
      <span class="seal">封</span>
      <p>还没到拆信的日子。</p>
      <p class="muted">还有 <span class="num">{{ daysUntil(today(), sealed.meta.open_on) }}</span> 天。</p>
    </div>

    <article v-if="letter" class="letter-paper">
      <p class="written">{{ writtenOn }}</p>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="prose letter-body" v-html="html" />
    </article>
    <div v-if="letter" class="acts">
      <router-link to="/letters/new" class="solid-btn reply">回一封，寄给以后</router-link>
    </div>
  </div>
</template>

<style scoped>
.read-letter { padding-bottom: calc(var(--safe-bottom) + 28px); }
.trash { margin-left: auto; margin-right: 6px; }
.letter-paper {
  margin: 8px 16px 0;
  padding: 18px 20px 22px;
  border: 1px solid var(--line);
  border-radius: 6px;
  /* 横线只画在内容区里，一行一条（行高 34px） */
  background: repeating-linear-gradient(transparent 0 33px, var(--line) 33px 34px) content-box, var(--surface);
  animation: rise-in 0.4s var(--ease-out);
}
.written { margin: 0; font-size: 13px; line-height: 34px; color: var(--muted); }
.letter-body { font-family: var(--kai); font-size: 18px; line-height: 34px; }
.letter-body :deep(p) { margin: 0 0 34px; }
.letter-body :deep(p:last-child) { margin-bottom: 0; }
.acts { display: flex; justify-content: center; margin-top: 22px; }
.reply { display: inline-flex; align-items: center; text-decoration: none; }
.sealed { display: flex; flex-direction: column; align-items: center; padding: 60px 32px; text-align: center; }
.sealed p { margin: 4px 0; }
.sealed p:first-of-type { margin-top: 16px; font-weight: 700; }
.seal { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 5px; background: var(--accent); color: var(--on-accent); font-family: var(--kai); font-size: 22px; }
</style>
