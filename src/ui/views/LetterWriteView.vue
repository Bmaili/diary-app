<script setup lang="ts">
/** 写一封信（规格 5.13）：写到一半离开也不丢（草稿存在这台手机上），封存后到期前看不到 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { today } from '../../app'
import { quickDates } from '../../core/letters'
import { addDays } from '../../core/time'
import { letterImageUrl, removeDraftImage, saveLetterImage, sealLetter } from '../../lettersService'
import { cleanCameraTemp, compress, pickImages } from '../../imageService'
import ImageSourceSheet from '../components/ImageSourceSheet.vue'
import { ask } from '../dialog'
import { prefs } from '../../prefs'
import Icon from '../components/Icon.vue'
import Switch from '../components/Switch.vue'

const router = useRouter()
const d = prefs.letterDraft
const t = today()
const quick = quickDates(t)
const tomorrow = addDays(t, 1)
const custom = ref(false)
const busy = ref(false)
const err = ref('')

onMounted(() => {
  // 默认一年后；草稿里的日期已经过了的话也换回一年后
  if (!d.openOn || d.openOn <= t) d.openOn = quick[0].date
  custom.value = !quick.some((q) => q.date === d.openOn)
})

const canSeal = computed(() => (d.body.trim().length > 0 || d.images.length > 0) && d.openOn > t)

// ---------- 随信附上的照片 ----------
const MAX_IMAGES = 9
const imgSheet = ref(false)
const imgBusy = ref('')
const imgNote = ref('')
const thumbs = reactive(new Map<string, string>())
watch(() => [...d.images], async (list) => {
  for (const p of list) if (!thumbs.has(p)) thumbs.set(p, await letterImageUrl(p).catch(() => ''))
}, { immediate: true })

async function addImages(source: 'camera' | 'gallery' | 'files') {
  imgSheet.value = false
  imgNote.value = ''
  let picked
  try {
    picked = await pickImages(source)
  } catch (e) {
    imgNote.value = `选图失败：${(e as Error).message}`
    return
  }
  if (!picked) return
  if (picked.note) imgNote.value = picked.note
  const room = MAX_IMAGES - d.images.length
  const blobs = picked.blobs.slice(0, room)
  try {
    for (let i = 0; i < blobs.length; i++) {
      imgBusy.value = blobs.length > 1 ? `${i + 1}/${blobs.length}` : '处理中'
      try {
        d.images.push(await saveLetterImage(await compress(blobs[i])))
      } catch (e) {
        imgNote.value = `有一张没附上：${(e as Error).message}`
      }
    }
    if (picked.blobs.length > room) imgNote.value = `一封信最多附 ${MAX_IMAGES} 张照片，多的没有附上。`
  } finally {
    picked.done()
    if (source === 'camera') void cleanCameraTemp()
    imgBusy.value = ''
  }
}

async function dropImage(i: number) {
  const p = d.images[i]
  if (!p || !(await ask({ title: '去掉这张照片？', message: '拍的照片没有存进系统相册，去掉就找不回来了。', ok: '去掉', cancel: '留着', danger: true }))) return
  d.images.splice(i, 1)
  thumbs.delete(p)
  await removeDraftImage(p)
}

function pickQuick(date: string) {
  d.openOn = date
  custom.value = false
}

async function seal() {
  if (!canSeal.value || busy.value) return
  busy.value = true
  err.value = ''
  try {
    await sealLetter({ body: d.body, openOn: d.openOn, remind: d.remind, images: [...d.images] })
    d.body = ''
    d.images = []
    d.openOn = ''
    d.remind = true
    router.replace('/letters')
  } catch (e) {
    err.value = `没有封存成功：${(e as Error).message}`
  } finally {
    busy.value = false
  }
}

function goBack() {
  if (window.history.state?.back) router.back()
  else router.replace('/letters')
}
</script>

<template>
  <div class="write-letter">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="goBack"><Icon name="back" /></button>
      <h1>写一封信</h1>
      <button class="seal-btn" :disabled="!canSeal || busy" @click="seal">{{ busy ? '封存中' : '封存' }}</button>
    </header>

    <label class="paper-wrap">
      <span class="sr">信的内容</span>
      <textarea v-model="d.body" class="letter-input" placeholder="一年后的我：&#10;&#10;现在的你在想什么、担心什么、盼着什么？写下来，到那天再读。" />
    </label>
    <div class="photos" aria-label="随信附上的照片">
      <div v-for="(p, i) in d.images" :key="p" class="ph">
        <img v-if="thumbs.get(p)" :src="thumbs.get(p)" alt="" />
        <button class="ph-x" aria-label="去掉这张照片" @click="dropImage(i)"><Icon name="close" /></button>
      </div>
      <button v-if="d.images.length < MAX_IMAGES" class="ph add" :disabled="!!imgBusy" @click="imgSheet = true">
        <Icon name="image" /><span>{{ imgBusy || '附上照片' }}</span>
      </button>
    </div>
    <p v-if="imgNote" class="draft-note">{{ imgNote }}</p>
    <p class="draft-note">写到一半离开也没关系，回来还在。</p>

    <h2 class="sec">哪天拆开</h2>
    <div class="chips">
      <button v-for="q in quick" :key="q.label" class="chip when" :class="{ on: !custom && d.openOn === q.date }" :aria-pressed="!custom && d.openOn === q.date" @click="pickQuick(q.date)">
        {{ q.label }}<span class="num">{{ q.date.replace(/-0?/g, '.') }}</span>
      </button>
      <button class="chip when" :class="{ on: custom }" :aria-pressed="custom" @click="custom = true">选个日子</button>
    </div>
    <label v-if="custom" class="date-row"><span>拆信日期</span><input v-model="d.openOn" type="date" class="field" :min="tomorrow" /></label>

    <div class="remind">
      <div>
        <div>到那天提醒我</div>
        <div class="desc">早上 9 点发一条通知，只说“有一封信到了”，不露内容</div>
      </div>
      <Switch v-model="d.remind" label="到那天提醒我" />
    </div>

    <p v-if="err" class="result bad pad">{{ err }}</p>
    <p class="foot-note">封存后到那天之前看不到内容，但可以改日期或者撤回。</p>
    <ImageSourceSheet :open="imgSheet" title="附上照片" @close="imgSheet = false" @pick="addImages" />
  </div>
</template>

<style scoped>
.write-letter { padding-bottom: calc(var(--safe-bottom) + 28px); }
.seal-btn { margin-left: auto; margin-right: 12px; min-height: 38px; padding: 0 18px; border: 0; border-radius: 19px; background: var(--accent); color: var(--on-accent); font: inherit; font-size: 15px; font-weight: 700; }
.seal-btn:disabled { opacity: 0.45; }
.paper-wrap { display: block; margin: 6px 16px 0; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.letter-input {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 46vh;
  padding: 16px 18px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background-color: var(--surface);
  background-image: repeating-linear-gradient(transparent 0 33px, var(--line) 33px 34px);
  background-position: 0 14px;
  background-attachment: local;
  color: var(--ink);
  font: inherit;
  font-size: 17px;
  line-height: 34px;
  resize: none;
}
.letter-input::placeholder { color: var(--faint); }
.photos { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 16px 0; }
.ph { position: relative; width: 76px; height: 76px; border-radius: 6px; overflow: hidden; background: var(--line); }
.ph img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ph-x { position: absolute; top: 2px; right: 2px; width: 26px; height: 26px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: rgba(0, 0, 0, 0.5); color: #fff; }
.ph-x svg { width: 14px; height: 14px; }
.ph.add { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; border: 1px dashed var(--faint); background: var(--surface); color: var(--muted); font: inherit; font-size: 12px; }
.ph.add svg { width: 22px; height: 22px; }
.ph.add:disabled { opacity: 0.6; }
.draft-note { margin: 6px 20px 0; font-size: 12px; color: var(--faint); }
.sec { margin: 18px 20px 10px; font-size: 14px; font-weight: 400; color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 16px; }
.chip.when { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; min-height: 44px; line-height: 1.2; }
.chip.when .num { font-size: 12px; opacity: 0.75; }
.date-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 20px 0; }
.date-row .field { max-width: 60%; }
.remind { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 18px 16px 0; padding: 14px 16px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.remind .desc { margin-top: 2px; font-size: 13px; color: var(--muted); line-height: 1.5; }
.foot-note { margin: 16px 24px 0; font-size: 13px; line-height: 1.6; color: var(--muted); text-align: center; }
</style>
