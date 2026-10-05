<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { prefs } from '../../prefs'
import { checkPin, disableLock, lock, setPin } from '../../lockService'
import { BIO_REASON, biometricAuth, biometricStatus, type BioStatus } from '../../platform/biometric'
import { onMounted } from 'vue'
import { Capacitor } from '@capacitor/core'
import Icon from '../components/Icon.vue'
import Switch from '../components/Switch.vue'
import PinPad from '../components/PinPad.vue'

const router = useRouter()
const native = Capacitor.isNativePlatform()

/** 输 PIN 的流程：verify（输旧的）→ new → confirm */
type Step = 'verify' | 'new' | 'confirm'
const flow = ref<null | { purpose: 'enable' | 'disable' | 'change'; step: Step; first: string }>(null)
const shake = ref(0)
const err = ref('')

const title = computed(() => {
  const f = flow.value
  if (!f) return ''
  if (f.step === 'verify') return '输入现在的 PIN'
  if (f.step === 'new') return '设置新的 PIN（4–8 位数字）'
  return '再输一次'
})

const delays = [
  { v: 0, label: '立即' },
  { v: 30, label: '30 秒' },
  { v: 60, label: '1 分钟' },
  { v: 300, label: '5 分钟' },
  { v: 900, label: '15 分钟' },
]
const syncOn = computed(() => prefs.sync.oss.enabled || prefs.sync.github.enabled)

// 指纹：打开前先验一次指纹，确认这台手机真的能用
const bio = ref<BioStatus | null>(null)
const bioMsg = ref('')
onMounted(async () => (bio.value = await biometricStatus()))
async function toggleBio(on: boolean) {
  bioMsg.value = ''
  if (!on) {
    prefs.lock.biometric = false
    return
  }
  const r = await biometricAuth('验证指纹', '取消')
  if (r.ok) prefs.lock.biometric = true
  else if (r.code !== 10 && r.code !== 13) bioMsg.value = r.message || '没有验证成功'
}

function toggle(on: boolean) {
  err.value = ''
  flow.value = on ? { purpose: 'enable', step: 'new', first: '' } : { purpose: 'disable', step: 'verify', first: '' }
}
function change() {
  err.value = ''
  flow.value = { purpose: 'change', step: 'verify', first: '' }
}

async function onPin(pin: string) {
  const f = flow.value
  if (!f) return
  err.value = ''
  if (f.step === 'verify') {
    if (!(await checkPin(pin))) {
      shake.value++
      err.value = 'PIN 不对'
      return
    }
    if (f.purpose === 'disable') {
      await disableLock()
      flow.value = null
    } else f.step = 'new'
  } else if (f.step === 'new') {
    f.first = pin
    f.step = 'confirm'
  } else {
    if (pin !== f.first) {
      shake.value++
      err.value = '两次输入不一样，请重新设置'
      f.step = 'new'
      f.first = ''
      return
    }
    await setPin(pin)
    flow.value = null
  }
}
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>应用锁</h1>
    </header>

    <p class="note">
      打开 app 时要输入 PIN，防止别人拿起手机翻看。<br />
      它不加密日记文件，也没有后门：忘记 PIN 只能清除 app 数据，手机上的日记会一起删掉。
      <template v-if="syncOn">你开了云端同步，清除后可以从云端恢复。</template>
      <template v-else><strong style="display: inline">你还没开云端同步，</strong>建议先开同步再上锁。</template>
    </p>

    <section>
      <div class="item">
        <div>
          <div>启用应用锁</div>
          <div class="desc">{{ prefs.lock.enabled ? '已启用' : '未启用' }}</div>
        </div>
        <Switch :model-value="prefs.lock.enabled" label="启用应用锁" @update:model-value="toggle" />
      </div>
      <template v-if="prefs.lock.enabled">
        <label class="item">
          <div>
            <div>离开多久后需要重新解锁</div>
            <div class="desc">切到别的 app 或锁屏后开始计时。选图片、导出分享时不会触发。</div>
          </div>
          <select v-model.number="prefs.lock.delaySec" class="field sel">
            <option v-for="d in delays" :key="d.v" :value="d.v">{{ d.label }}</option>
          </select>
        </label>
        <div class="item">
          <div>
            <div>在最近任务里隐藏内容</div>
            <div class="desc">多任务界面显示空白。安卓的限制：打开后本 app 也不能截屏和录屏。{{ native ? '' : '（浏览器里无效）' }}</div>
          </div>
          <Switch v-model="prefs.lock.hideInRecents" label="在最近任务里隐藏内容" />
        </div>
        <div class="item">
          <div>
            <div>指纹解锁</div>
            <div class="desc">{{ bio && !bio.available ? BIO_REASON[bio.reason] : '解锁时先弹指纹，取消或识别不了时仍可输入 PIN。' }}</div>
            <div v-if="bioMsg" class="result bad">{{ bioMsg }}</div>
          </div>
          <Switch :model-value="prefs.lock.biometric" label="指纹解锁" :disabled="!bio?.available" @update:model-value="toggleBio" />
        </div>
        <button class="item link" @click="change">
          <div><div>修改 PIN</div></div>
          <Icon name="right" class="chev" />
        </button>
      </template>
    </section>

    <div v-if="flow" class="pin-modal sky-bg" role="dialog" aria-modal="true" :aria-label="title">
      <button class="icon-btn close" aria-label="取消" @click="flow = null"><Icon name="close" /></button>
      <div class="pin-head">
        <h2>{{ title }}</h2>
        <p class="err">{{ err }}</p>
      </div>
      <PinPad :key="flow.step" :len="flow.step === 'verify' ? lock.len : undefined" :shake="shake" @submit="onPin" />
    </div>
  </div>
</template>

<style scoped>
.sel { width: auto; min-height: 38px; padding: 0 8px; }
.pin-modal {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 36px;
  padding: calc(24px + var(--safe-top)) 16px calc(24px + var(--safe-bottom));
}
.close { position: absolute; top: calc(8px + var(--safe-top)); right: 8px; }
.pin-head { text-align: center; }
.pin-head h2 { margin: 0 0 6px; font-size: 18px; }
.err { margin: 0; min-height: 1.5em; color: var(--danger); font-size: 14px; }
</style>
