<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { prefs } from '../../prefs'
import { settings, today } from '../../app'
import { reminderSupported, requestReminderPermission } from '../../reminderService'
import { reminderText } from '../../core/reminder'
import Icon from '../components/Icon.vue'
import Switch from '../components/Switch.vue'

const router = useRouter()
const msg = ref('')
const preview = computed(() => reminderText(today()))
const lateNight = computed(() => Number(prefs.reminder.time.split(':')[0]) < settings.cutoffHour)

async function toggle(on: boolean) {
  msg.value = ''
  if (!on) {
    prefs.reminder.enabled = false
    return
  }
  if (!(await requestReminderPermission())) {
    msg.value = '没有拿到通知权限。请在系统设置的“应用管理 → 日记 → 通知”里允许通知后再打开。'
    return
  }
  prefs.reminder.enabled = true
}
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>写日记提醒</h1>
    </header>

    <p v-if="!reminderSupported" class="note warn">提醒只在手机上有效，浏览器里可以设置但不会弹出。</p>

    <section>
      <div class="item">
        <div>
          <div>每天提醒</div>
          <div class="desc">默认关闭。打开时会请求通知权限。</div>
          <div v-if="msg" class="result bad">{{ msg }}</div>
        </div>
        <Switch :model-value="prefs.reminder.enabled" label="每天提醒" :disabled="!reminderSupported" @update:model-value="toggle" />
      </div>
      <label class="item">
        <div>
          <div>提醒时间</div>
          <div v-if="lateNight" class="desc">早于凌晨 {{ settings.cutoffHour }} 点，算作前一天的深夜提醒。</div>
        </div>
        <input v-model="prefs.reminder.time" type="time" class="field time" />
      </label>
      <div class="item">
        <div>
          <div>今天写过就不提醒</div>
        </div>
        <Switch v-model="prefs.reminder.skipWritten" label="今天写过就不提醒" />
      </div>
    </section>

    <section>
      <h2>通知长这样</h2>
      <div class="notif">
        <div class="n-title">{{ preview.title }}</div>
        <div class="n-body">{{ preview.body }}</div>
      </div>
      <p class="desc pad">每条都会带上当天的农历、节气或节日。提醒排好未来两周，期间打开一次 app 就会续上。部分手机为了省电会晚几分钟弹出。</p>
    </section>
  </div>
</template>

<style scoped>
.time { width: auto; min-height: 38px; padding: 0 8px; }
.notif {
  margin: 0 16px 10px;
  padding: 12px 14px;
  border-radius: 16px;
  border: 1px solid var(--line);
  background: var(--surface);
}
.n-title { font-weight: 700; font-size: 15px; }
.n-body { margin-top: 2px; font-size: 14px; color: var(--muted); }
</style>
