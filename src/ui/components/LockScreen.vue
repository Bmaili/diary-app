<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { lock, unlock, unlockWithBiometric } from '../../lockService'
import { biometricStatus } from '../../platform/biometric'
import Icon from './Icon.vue'
import { prefs } from '../../prefs'
import Seal from './Seal.vue'
import PinPad from './PinPad.vue'

const shake = ref(0)
const msg = ref('')
const now = ref(Date.now())
const showForgot = ref(false)
let timer: ReturnType<typeof setInterval> | undefined
/** 开了指纹解锁并且手机能用：锁屏一出来就弹指纹框，取消了可以点按钮再弹，或者输 PIN */
const bio = ref(false)
const bioBusy = ref(false)
async function tryBio() {
  if (bioBusy.value) return
  bioBusy.value = true
  try {
    const r = await unlockWithBiometric()
    if (r.ok) return
    if (r.code === 7 || r.code === 9) msg.value = '指纹试错太多次，请输入 PIN'
    else if (r.code !== 10 && r.code !== 13 && r.code !== 5 && r.message) msg.value = r.message
  } finally {
    bioBusy.value = false
  }
}
onMounted(async () => {
  timer = setInterval(() => (now.value = Date.now()), 1000)
  if (prefs.lock.biometric && (await biometricStatus()).available) {
    bio.value = true
    if (document.visibilityState === 'visible') void tryBio()
  }
})
onUnmounted(() => clearInterval(timer))

const wait = computed(() => Math.max(0, Math.ceil((lock.until - now.value) / 1000)))
const syncOn = computed(() => prefs.sync.oss.enabled || prefs.sync.github.enabled)

async function submit(pin: string) {
  const r = await unlock(pin)
  if (r === 'ok') {
    msg.value = ''
    return
  }
  shake.value++
  msg.value = r === 'wait' ? '' : lock.failures >= 3 ? `PIN 不对（已错 ${lock.failures} 次）` : 'PIN 不对'
}
</script>

<template>
  <div class="lock sky-bg" role="dialog" aria-modal="true" aria-label="应用已上锁">
    <div class="top">
      <Seal text="浮生" :size="52" />
      <h1>日记已上锁</h1>
      <p class="sub">{{ wait ? `请等待 ${wait} 秒再试` : msg || '输入 PIN 继续' }}</p>
    </div>
    <PinPad :len="lock.len" :disabled="wait > 0" :shake="shake" @submit="submit">
      <template #extra>
        <button v-if="bio" class="bio" aria-label="用指纹解锁" :disabled="bioBusy" @click="tryBio"><Icon name="fingerprint" /></button>
        <button v-else class="forgot" @click="showForgot = true">忘记了</button>
      </template>
    </PinPad>
    <button v-if="bio" class="forgot under" @click="showForgot = true">忘记 PIN 了</button>
    <div v-if="showForgot" class="forgot-box" role="alertdialog">
      <p>应用锁没有后门。忘记 PIN 只能在系统设置里清除本 app 的数据，这会<strong>删掉手机上的全部日记</strong>。</p>
      <p v-if="syncOn">你开启了云端同步，清除后可以在“设置 → 同步与备份 → 从云端恢复”里找回已同步的日记；最近还没同步上去的部分会丢失。</p>
      <p v-else>你没有开启云端同步，清除数据后日记无法找回。建议先多试几次。</p>
      <button class="text-btn" @click="showForgot = false">知道了</button>
    </div>
  </div>
</template>

<style scoped>
.lock {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 40px;
  padding: calc(24px + var(--safe-top)) 16px calc(24px + var(--safe-bottom));
}
.top { display: flex; flex-direction: column; align-items: center; text-align: center; }
h1 { margin: 14px 0 4px; font-size: 20px; color: var(--ink); letter-spacing: 0.08em; }
.sub { margin: 0; min-height: 1.5em; color: var(--muted); font-size: 14px; }
.forgot { border: 0; background: transparent; color: var(--muted); font-size: 14px; }
.forgot.under { margin-top: -20px; }
.bio { display: grid; place-items: center; width: 64px; height: 64px; border: 0; border-radius: 50%; background: transparent; color: var(--accent); }
.bio svg { width: 34px; height: 34px; }
.bio:active { background: var(--line); }
.forgot-box {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: calc(24px + var(--safe-bottom));
  padding: 14px 16px;
  border-radius: 16px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 14px;
  line-height: 1.65;
}
.forgot-box p { margin: 0 0 8px; }
</style>
