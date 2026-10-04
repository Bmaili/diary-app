<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { prefs } from '../../prefs'
import { TASK_LABEL, type Task } from '../../aiService'
import Icon from '../components/Icon.vue'

const router = useRouter()
const tasks: Task[] = ['chat', 'extract', 'summary']
const noteHint: Record<Task, string> = {
  chat: '比如：回答尽量简短；先说结论再列日期。',
  extract: '比如：标签只用 工作、运动、读书、聚餐、旅行、家人 这几个；地点写到店名就行，不要写城市。',
  summary: '比如：口气轻松一点；多写变化少写流水账；每份不超过 500 字。',
}
const showTaskNotes = ref(tasks.some((t) => prefs.ai.taskNotes[t]?.trim()))
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
          placeholder="比如：&#10;小雨是我女朋友，“老地方”指公司楼下的兰州拉面。&#10;阿乐是我养的猫，不是人。" />
        <p class="hint">问答、抽取和总结都会带上这段话。适合写事实：日记里的称呼、简写、昵称分别指谁、指哪里。它会随请求发给 AI 服务，不会写进日记文件。</p>
        <button type="button" class="sub-toggle" :aria-expanded="showTaskNotes" @click="showTaskNotes = !showTaskNotes">
          分功能的补充说明<Icon :name="showTaskNotes ? 'close' : 'right'" class="chev" />
        </button>
        <template v-if="showTaskNotes">
          <p class="hint">只发给对应的功能，接在上面那段后面。适合写风格和规则：回答的长短、总结的口气、标签用哪些词。</p>
          <label v-for="t in tasks" :key="t">
            <span>只给{{ TASK_LABEL[t] }}</span>
            <textarea v-model="prefs.ai.taskNotes[t]" class="field notes small" rows="3" maxlength="1500" :placeholder="noteHint[t]" />
          </label>
        </template>
      </div>
    </section>

    <section>
      <h2>问答</h2>
      <label class="item">
        <div>
          <div>带上前几轮对话</div>
          <div class="desc">追问时 AI 能看到同一个对话里最近几轮的问和答（不含查到的原文）。0 表示每次都是新问题。</div>
        </div>
        <select v-model.number="prefs.ai.chat.historyTurns" class="field sel">
          <option v-for="n in [0, 2, 4, 6, 10]" :key="n" :value="n">{{ n }} 轮</option>
        </select>
      </label>
      <label class="item">
        <div>
          <div>每个问题最多查几轮</div>
          <div class="desc">AI 一轮可以调用几个工具。轮数多能回答更复杂的问题，也更费 token。</div>
        </div>
        <select v-model.number="prefs.ai.chat.maxRounds" class="field sel">
          <option v-for="n in [5, 10, 15, 20]" :key="n" :value="n">{{ n }} 轮</option>
        </select>
      </label>
    </section>

    <section>
      <h2>抽取</h2>
      <label class="item">
        <div>
          <div>批量标注时同时处理几篇</div>
          <div class="desc">多一些更快，但容易碰到服务商的频率限制（报 429）。</div>
        </div>
        <select v-model.number="prefs.ai.extract.concurrency" class="field sel">
          <option v-for="n in [1, 2, 3, 4]" :key="n" :value="n">{{ n }} 篇</option>
        </select>
      </label>
    </section>
  </div>
</template>

<style scoped>
.notes { min-height: 120px; padding: 10px 12px; resize: vertical; line-height: 1.6; }
.notes.small { min-height: 76px; }
.sub-toggle {
  display: flex;
  align-items: center;
  width: 100%;
  margin-top: 14px;
  padding: 10px 0;
  border: 0;
  border-top: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  font-size: 15px;
  font-weight: 600;
  text-align: left;
}
.sub-toggle .chev { margin-left: auto; }
.sel { width: auto; max-width: 40vw; min-height: 38px; padding: 0 8px; }
</style>
