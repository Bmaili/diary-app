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
      <div class="orrery" aria-hidden="true">
        <span class="core"></span>
        <span class="ring r1"><i></i></span>
        <span class="ring r2"><i></i></span>
      </div>
      <p class="lead">AI 还在路上，第四阶段上线。</p>
      <p class="muted">
        到时可以直接问“过去一年去过几次某家饭店”“这几年都发生了什么”，也能让它帮你标注人物和地点、写月度和年度总结。它读的，就是你现在写下的这些文件。
      </p>
      <p v-if="stats.count" class="muted small">
        目前有 <span class="num">{{ stats.count }}</span> 篇日记，从 <span class="num">{{ stats.first }}</span> 到
        <span class="num">{{ stats.last }}</span>。
      </p>
    </div>
  </div>
</template>

<style scoped>
.wrap { padding: 8px 24px; max-width: 34em; }
.orrery { position: relative; width: 160px; height: 160px; margin: 8px auto 20px; }
.core {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 22px;
  height: 22px;
  margin: -11px 0 0 -11px;
  border-radius: 50%;
  background: var(--m3);
  box-shadow: 0 0 24px var(--m3);
}
.ring { position: absolute; inset: 0; border: 1px dashed var(--faint); border-radius: 50%; animation: spin 18s linear infinite; }
.ring.r1 { inset: 36px; animation-duration: 9s; }
.ring i { position: absolute; top: -5px; left: 50%; width: 10px; height: 10px; margin-left: -5px; border-radius: 50%; background: var(--m5); box-shadow: 0 0 10px var(--m5); }
.ring.r1 i { width: 7px; height: 7px; top: -3.5px; margin-left: -3.5px; background: var(--m1); box-shadow: 0 0 8px var(--m1); }
@keyframes spin { to { transform: rotate(360deg); } }
.lead { font-size: 20px; font-weight: 800; line-height: 1.5; margin: 0 0 10px; text-align: center; }
.small { font-size: 13px; }
.small .num { font-size: 15px; color: var(--ink); }
</style>
