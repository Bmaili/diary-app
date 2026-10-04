<script setup lang="ts">
import { useRouter } from 'vue-router'
import { prefs } from '../../prefs'
import { TASK_LABEL, type Task } from '../../aiService'
import Icon from '../components/Icon.vue'

const router = useRouter()
const tasks: Task[] = ['chat', 'extract', 'summary']
const desc: Record<Task, string> = {
  chat: '在 AI 页提问。需要支持工具调用的模型。',
  extract: '从日记里标出人物、地点、标签。可以用便宜一些的模型。',
  summary: '写月度和年度总结。',
}
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>AI 服务</h1>
    </header>

    <p class="note">
      填入任何兼容 OpenAI 接口的服务（DeepSeek、通义千问、Kimi、智谱等），或 Anthropic 的接口。
      API Key 只加密保存在这台手机上，不会同步。
    </p>

    <section>
      <h2>已添加的服务</h2>
      <router-link v-for="p in prefs.ai.profiles" :key="p.id" :to="`/settings/ai/${p.id}`" class="item link">
        <div>
          <div>{{ p.name }}</div>
          <div class="desc">{{ p.model }}，{{ p.protocol === 'anthropic' ? 'Anthropic 协议' : 'OpenAI 兼容协议' }}</div>
        </div>
        <Icon name="right" class="chev" />
      </router-link>
      <router-link to="/settings/ai/new" class="item link">
        <div><div>添加服务</div></div>
        <Icon name="plus" class="chev" />
      </router-link>
    </section>

    <section v-if="prefs.ai.profiles.length > 1">
      <h2>各项功能用哪个</h2>
      <label v-for="t in tasks" :key="t" class="item">
        <div>
          <div>{{ TASK_LABEL[t] }}</div>
          <div class="desc">{{ desc[t] }}</div>
        </div>
        <select v-model="prefs.ai.use[t]" class="field sel">
          <option value="">第一个</option>
          <option v-for="p in prefs.ai.profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
    </section>

    <section>
      <h2>给 AI 的补充说明</h2>
      <div class="form">
        <textarea v-model="prefs.ai.notes" class="field notes" rows="5" maxlength="2000"
          placeholder="比如：&#10;小雨是我女朋友，“老地方”指公司楼下的兰州拉面。&#10;总结用第二人称，口气轻松一点。&#10;回答尽量简短。" />
        <p class="hint">问答、抽取和总结都会带上这段话，帮 AI 认出日记里的称呼和简写。它会随请求发给 AI 服务，不会写进日记文件。</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.notes { min-height: 120px; padding: 10px 12px; resize: vertical; line-height: 1.6; }
.sel { width: auto; max-width: 40vw; min-height: 38px; padding: 0 8px; }
</style>
