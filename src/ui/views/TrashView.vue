<script setup lang="ts">
/** 最近删除：删掉的日记在这里保留 30 天，可以恢复或彻底删除 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { diaryChanged, enqueue, refreshDate, repo, store } from '../../app'
import { imageDays, KEEP_DAYS, listTrash, purgeTrashItem, restoreTrash, TRASH, type TrashItem } from '../../core/trash'
import { pathUrl } from '../../imageService'
import { parseYmd } from '../../core/time'
import Icon from '../components/Icon.vue'
import { ask } from '../dialog'
import { reloadLetters } from '../../lettersService'

const router = useRouter()
const items = ref<TrashItem[]>([])
const loaded = ref(false)
const msg = ref<Record<string, string>>({})
const busy = ref('')

/** 图片条目的缩略图（最多 4 张） */
const thumbs = ref<Record<string, string[]>>({})
async function load() {
  items.value = await listTrash(store)
  loaded.value = true
  for (const t of items.value) {
    if (t.kind !== 'images' || thumbs.value[t.id]) continue
    const urls = await Promise.all(t.files.slice(0, 4).map((f) => pathUrl(`${TRASH}/${t.id}/${f}`).catch(() => '')))
    thumbs.value = { ...thumbs.value, [t.id]: urls.filter(Boolean) }
  }
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
/** 条目标题 */
function title(t: TrashItem) {
  if (t.kind === 'letter') return `${label(t.date)}`
  if (t.kind === 'images') return t.source === 'cleanup' ? `清理出的 ${t.files.length} 张图片` : `编辑时去掉的 ${t.files.length} 张图片`
  return label(t.date)
}
function imagesNote(t: TrashItem) {
  const days = imageDays(t)
  const d = (x: string) => `${Number(x.slice(5, 7))} 月 ${Number(x.slice(8, 10))} 日`
  return days.length === 1 ? `恢复时接回 ${d(days[0])}日记的末尾` : `恢复时接回 ${days.length} 天日记的末尾`
}

async function restore(t: TrashItem) {
  if (busy.value) return
  busy.value = t.id
  try {
    const date = await enqueue(async () => {
      const d = await restoreTrash(repo, t.id)
      for (const x of t.kind === 'images' ? imageDays(t) : [d]) await refreshDate(x)
      return d
    })
    diaryChanged()
    if (t.kind === 'letter') void reloadLetters()
    await load()
    msg.value = {
      ...msg.value,
      done: t.kind === 'letter' ? `已恢复 ${label(date)} 写的信` : t.kind === 'images' ? `图片已放回，${imagesNote(t).replace('恢复时', '')}` : `已恢复 ${label(date)}`,
    }
  } catch (e) {
    msg.value = { ...msg.value, [t.id]: (e as Error).message }
  } finally {
    busy.value = ''
  }
}

async function purge(t: TrashItem) {
  const what = t.kind === 'letter' ? `${label(t.date)} 写的信` : t.kind === 'images' ? `这 ${t.files.length} 张图片` : `${label(t.date)} 的日记`
  if (busy.value || !(await ask({ title: `彻底删除${what}？`, message: '之后无法找回。', ok: '彻底删除', danger: true }))) return
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
      删掉的日记（连同那天插的图片）、编辑时从正文里去掉的图片，都在这里保留 {{ KEEP_DAYS }} 天。它们只在这台手机上：云端的副本在删除后的下一次同步时就删了，恢复后会重新上传。
    </p>
    <p v-if="msg.done" class="result pad">{{ msg.done }}</p>

    <section>
      <p v-if="loaded && !items.length" class="desc pad">没有删除过的日记。</p>
      <div v-for="t in items" :key="t.id" class="item">
        <div>
          <div class="num-date">{{ title(t) }}<span v-if="t.kind === 'letter'" class="kind">写的信</span></div>
          <template v-if="t.kind === 'images'">
            <div v-if="thumbs[t.id]?.length" class="thumbs">
              <img v-for="(u, i) in thumbs[t.id]" :key="i" :src="u" alt="" />
              <span v-if="t.files.length > 4" class="more num">+{{ t.files.length - 4 }}</span>
            </div>
            <div class="desc">{{ imagesNote(t) }}</div>
            <div class="desc">{{ left(t) }}</div>
          </template>
          <template v-else>
            <div class="desc preview">{{ t.preview || (t.mood ? '只记了心情' : '（无正文）') }}</div>
            <div class="desc">{{ left(t) }}<template v-if="images(t)">，含 {{ images(t) }} 张图片</template></div>
          </template>
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
.kind { margin-left: 6px; font-weight: 400; color: var(--muted); }
.preview { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.acts { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex: none; }
.danger { color: var(--danger); }
.thumbs { display: flex; align-items: center; gap: 6px; margin: 6px 0 2px; }
.thumbs img { width: 48px; height: 48px; object-fit: cover; border-radius: 6px; border: 1px solid var(--line); background: var(--surface); }
.thumbs .more { font-size: 13px; color: var(--muted); }
</style>
