<script setup lang="ts">
/** 最近删除：删掉的日记在这里保留 30 天，可以恢复或彻底删除 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { diaryChanged, enqueue, refreshDate, repo, store } from '../../app'
import { KEEP_DAYS, listTrash, purgeTrashItem, restoreTrash, type TrashItem } from '../../core/trash'
import { parseYmd } from '../../core/time'
import Icon from '../components/Icon.vue'

const router = useRouter()
const items = ref<TrashItem[]>([])
const loaded = ref(false)
const msg = ref<Record<string, string>>({})
const busy = ref('')

async function load() {
  items.value = await listTrash(store)
  loaded.value = true
}
onMounted(load)

function label(date: string) {
  const d = parseYmd(date)
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}
function left(t: TrashItem) {
  const days = Math.max(0, KEEP_DAYS - Math.floor((Date.now() - t.deletedAt) / 86400000))
  return days ? `${days} 天后彻底删除` : '即将彻底删除'
}
const images = (t: TrashItem) => t.files.filter((f) => f.startsWith('attachments/')).length

async function restore(t: TrashItem) {
  if (busy.value) return
  busy.value = t.id
  try {
    const date = await enqueue(async () => {
      const d = await restoreTrash(repo, t.id)
      await refreshDate(d)
      return d
    })
    diaryChanged()
    await load()
    msg.value = { ...msg.value, done: `已恢复 ${label(date)}` }
  } catch (e) {
    msg.value = { ...msg.value, [t.id]: (e as Error).message }
  } finally {
    busy.value = ''
  }
}

async function purge(t: TrashItem) {
  if (busy.value || !window.confirm(`彻底删除 ${label(t.date)} 的日记？之后无法找回。`)) return
  busy.value = t.id
  try {
    await purgeTrashItem(store, t.id)
    await load()
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>最近删除</h1>
    </header>

    <p class="note">
      删掉的日记连同那天插的图片在这里保留 {{ KEEP_DAYS }} 天。它们只在这台手机上：云端的副本在删除后的下一次同步时就删了，恢复后会重新上传。
    </p>
    <p v-if="msg.done" class="result pad">{{ msg.done }}</p>

    <section>
      <p v-if="loaded && !items.length" class="desc pad">没有删除过的日记。</p>
      <div v-for="t in items" :key="t.id" class="item">
        <div>
          <div class="num-date">{{ label(t.date) }}</div>
          <div class="desc preview">{{ t.preview || '（无正文）' }}</div>
          <div class="desc">{{ left(t) }}<template v-if="images(t)">，含 {{ images(t) }} 张图片</template></div>
          <div v-if="msg[t.id]" class="result bad">{{ msg[t.id] }}</div>
        </div>
        <div class="acts">
          <button class="text-btn" :disabled="!!busy" @click="restore(t)">恢复</button>
          <button class="text-btn danger" :disabled="!!busy" @click="purge(t)">彻底删除</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.num-date { font-weight: 600; }
.preview { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.acts { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex: none; }
.danger { color: var(--danger); }
</style>
