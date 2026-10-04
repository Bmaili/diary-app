<script setup lang="ts">
import { computed } from 'vue'
import { index, indexVersion } from '../../app'

const stats = computed(() => {
  void indexVersion.value
  const all = index.all()
  return { count: all.length, first: all[all.length - 1]?.date, last: all[0]?.date }
})
</script>

<template>
  <div class="page">
    <header class="topbar"><h1>AI</h1></header>
    <div class="wrap">
      <p class="lead">问答、自动标注地点和人物、月度和年度总结，会在第四阶段加入。</p>
      <p class="muted">
        到时你可以问“过去一年去过几次某家饭店”“总结一下今年”。现在先安心写，这些功能读的就是你此刻写下的文件。
      </p>
      <p v-if="stats.count" class="muted small">
        目前共有 {{ stats.count }} 篇日记，从 {{ stats.first }} 到 {{ stats.last }}。
      </p>
    </div>
  </div>
</template>

<style scoped>
.wrap { padding: 16px 24px; max-width: 34em; }
.lead { font-size: 18px; font-weight: 700; line-height: 1.6; margin: 8px 0 12px; }
.small { font-size: 13px; }
</style>
