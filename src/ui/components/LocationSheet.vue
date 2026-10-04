<script setup lang="ts">
/**
 * 选地点（规格 5.4）：列出附近 300 米的地点，按距离排序；顶部可搜关键词；
 * 也可以只记坐标，或不记录。补写往日日记时不定位，只能搜。
 */
import { ref, watch } from 'vue'
import Sheet from './Sheet.vue'
import Icon from './Icon.vue'
import type { Location } from '../../core/types'
import type { Poi } from '../../core/geo/amap'
import { findPlaces, getPosition, nearbyPlaces, poiToLocation, type Position } from '../../placeService'

const props = defineProps<{ open: boolean; current?: Location; canLocate: boolean }>()
const emit = defineEmits<{ close: []; pick: [Location | null] }>()

const pos = ref<{ lat: number; lng: number } | null>(null)
const pois = ref<Poi[]>([])
const q = ref('')
const loading = ref(false)
const err = ref('')

async function load(keywords?: string) {
  loading.value = true
  err.value = ''
  try {
    if (pos.value) pois.value = await nearbyPlaces(pos.value, keywords)
    else if (keywords) pois.value = await findPlaces(keywords)
    else pois.value = []
  } catch (e) {
    err.value = (e as Error).message
    pois.value = []
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  async (o) => {
    if (!o) return
    q.value = ''
    pois.value = []
    err.value = ''
    const c = props.current
    pos.value = c?.lat != null && c?.lng != null ? { lat: c.lat, lng: c.lng } : null
    if (!pos.value && props.canLocate) {
      loading.value = true
      try {
        const p: Position = await getPosition()
        pos.value = { lat: p.lat, lng: p.lng }
      } catch (e) {
        err.value = `${(e as Error).message}，可以搜索地点`
      } finally {
        loading.value = false
      }
    }
    if (pos.value) void load()
  },
)

function search() {
  void load(q.value.trim() || undefined)
}

function coordsOnly() {
  if (!pos.value) return
  const c = props.current
  emit('pick', { lat: pos.value.lat, lng: pos.value.lng, crs: 'wgs84', ...(c?.address && !c?.name ? { address: c.address } : {}) })
}

const dist = (m: number | null) => (m == null ? '' : m < 1000 ? `${m} 米` : `${(m / 1000).toFixed(1)} 公里`)
</script>

<template>
  <Sheet :open="open" title="在哪里" @close="emit('close')">
    <form class="search" @submit.prevent="search">
      <input v-model="q" class="field" :placeholder="pos ? '搜索附近的地点' : '搜索地点，如 星巴克 天河城'" enterkeyhint="search" />
      <button class="text-btn" type="submit">搜索</button>
    </form>
    <p v-if="current?.name || current?.address" class="now">现在：{{ current.name || current.address }}</p>
    <p v-if="loading" class="muted small">正在找附近的地点……</p>
    <p v-if="err" class="small err">{{ err }}</p>
    <ul class="list">
      <li v-for="p in pois" :key="p.id + p.name">
        <button class="poi" @click="emit('pick', poiToLocation(p))">
          <Icon name="pin" class="pin" />
          <span class="txt">
            <span class="name">{{ p.name }}</span>
            <span class="addr">{{ [p.type, p.address].filter(Boolean).join('，') }}</span>
          </span>
          <span class="d num">{{ dist(p.distance) }}</span>
        </button>
      </li>
    </ul>
    <div class="actions">
      <button v-if="pos" class="text-btn" @click="coordsOnly">只记坐标</button>
      <button class="text-btn danger" @click="emit('pick', null)">不记录位置</button>
    </div>
  </Sheet>
</template>

<style scoped>
.search { display: flex; gap: 8px; }
.now { margin: 10px 0 0; font-size: 13px; color: var(--muted); }
.small { font-size: 13px; margin: 10px 0 0; }
.err { color: var(--danger); }
.list { list-style: none; margin: 8px 0 0; padding: 0; max-height: 46vh; overflow-y: auto; }
.poi {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 2px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  text-align: left;
}
.poi:active { background: var(--surface); }
.pin { width: 18px; height: 18px; color: var(--faint); flex: none; }
.txt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.name { font-weight: 600; }
.addr { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.d { font-size: 14px; color: var(--muted); flex: none; }
.actions { display: flex; justify-content: space-between; margin-top: 10px; }
.danger { color: var(--danger); }
</style>
