<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { prefs } from '../../prefs'
import { getSecret, setSecret } from '../../platform/secrets'
import { fetchWeather, getPosition, resolveCity } from '../../placeService'
import { reverseGeocode } from '../../core/geo/amap'
import { outOfChina } from '../../core/geo/coords'
import Icon from '../components/Icon.vue'
import Switch from '../components/Switch.vue'

const router = useRouter()
const amapKey = ref('')
const qwKey = ref('')
const city = ref(prefs.place.defaultCity?.name ?? '')
const cityMsg = ref('')
const testMsg = ref<string[]>([])
const testing = ref(false)

onMounted(async () => {
  amapKey.value = await getSecret('amap.key')
  qwKey.value = await getSecret('qweather.key')
})

async function saveKeys() {
  await setSecret('amap.key', amapKey.value.trim())
  await setSecret('qweather.key', qwKey.value.trim())
}

async function setCity() {
  cityMsg.value = ''
  if (!city.value.trim()) {
    prefs.place.defaultCity = null
    return
  }
  await saveKeys()
  const r = await resolveCity(city.value.trim()).catch((e) => {
    cityMsg.value = (e as Error).message
    return null
  })
  if (r) {
    prefs.place.defaultCity = { name: city.value.trim(), lat: r.lat, lng: r.lng }
    cityMsg.value = `已设置：${r.name}`
  } else if (!cityMsg.value) cityMsg.value = '没找到这个城市'
}

async function test() {
  testing.value = true
  testMsg.value = []
  await saveKeys()
  try {
    const p = await getPosition()
    testMsg.value.push(`定位成功：${p.lat}, ${p.lng}（精度约 ${Math.round(p.accuracy)} 米）`)
    if (amapKey.value && !outOfChina(p.lat, p.lng)) {
      try {
        testMsg.value.push(`地址：${(await reverseGeocode(amapKey.value.trim(), p.lat, p.lng)).address}`)
      } catch (e) {
        testMsg.value.push((e as Error).message)
      }
    } else if (amapKey.value) testMsg.value.push('当前在中国大陆以外，高德查不到地址，只记坐标。')
    try {
      const w = await fetchWeather(p.lat, p.lng)
      testMsg.value.push(`天气：${w.text} ${w.temp_c}°C`)
    } catch (e) {
      testMsg.value.push(`天气：${(e as Error).message}`)
    }
  } catch (e) {
    testMsg.value.push((e as Error).message)
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="saveKeys().then(() => router.back())"><Icon name="back" /></button>
      <h1>位置与天气</h1>
    </header>

    <section>
      <div class="item">
        <div>
          <div>写日记时自动记录位置和天气</div>
          <div class="desc">只在写当天的日记、打开编辑页时定位一次，不在后台定位。补写往日日记不会定位。</div>
        </div>
        <Switch v-model="prefs.place.autoLocate" label="自动记录位置和天气" />
      </div>
    </section>

    <section class="form">
      <h2 style="margin: 0">高德地图</h2>
      <label>
        <span>Web 服务 key</span>
        <input v-model="amapKey" class="field" type="password" autocomplete="off" @blur="saveKeys" />
      </label>
      <p class="hint">
        在高德开放平台创建应用，添加 key 时“服务平台”选 <strong>Web 服务</strong>。填了才能把坐标换成地址、列出附近的地点；不填就只记坐标。
      </p>

      <h2 style="margin: 22px 0 0">天气</h2>
      <label>
        <span>天气来源</span>
        <select v-model="prefs.place.weatherProvider" class="field">
          <option value="auto">填了和风天气就用它，否则用 Open-Meteo</option>
          <option value="qweather">只用和风天气</option>
          <option value="openmeteo">只用 Open-Meteo（不需要 key）</option>
        </select>
      </label>
      <label>
        <span>和风天气 API Host</span>
        <input v-model="prefs.place.qweatherHost" class="field" placeholder="xxxxxx.re.qweatherapi.com" autocapitalize="off" />
      </label>
      <label>
        <span>和风天气 key</span>
        <input v-model="qwKey" class="field" type="password" autocomplete="off" @blur="saveKeys" />
      </label>
      <p class="hint">API Host 在和风天气控制台的“设置”里，每个账号不一样。</p>

      <h2 style="margin: 22px 0 0">默认城市</h2>
      <label>
        <span>定位失败时，按这个城市取天气</span>
        <div style="display: flex; gap: 8px">
          <input v-model="city" class="field" placeholder="如 广州" />
          <button class="text-btn" @click="setCity">设置</button>
        </div>
      </label>
      <p v-if="cityMsg" class="result">{{ cityMsg }}</p>

      <div class="row">
        <button class="solid-btn" :disabled="testing" @click="test">{{ testing ? '测试中' : '现在定位一次试试' }}</button>
      </div>
      <ul v-if="testMsg.length" class="test">
        <li v-for="m in testMsg" :key="m">{{ m }}</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.test { margin: 12px 0 0; padding-left: 18px; font-size: 14px; line-height: 1.7; }
</style>
