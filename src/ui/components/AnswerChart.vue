<script setup lang="ts">
/**
 * 问答回答里的图表（2026-10-12 加入）。数据来自工具结果（core/llm/charts.ts），手写 SVG，不引入图表库。
 * 柱状图、折线（平均心情）、横向排行、心情构成、日历格子五种；几组对比用 --s1…--s4，心情用 --m1…--m5，
 * 朱红只标最高的那一根。点柱子、点点、点行显示数值；日历格子点一下打开那天的日记。下面可以展开看数据表。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { HEATMAP_MONTHS, monthlyCounts, pickKind, type ChartData, type ChartGroup } from '../../core/llm/charts'
import { index } from '../../app'

const props = defineProps<{ data: ChartData; kind?: string }>()
const router = useRouter()
const uid = `ch${Math.random().toString(36).slice(2, 8)}`

const kind = computed(() => pickKind(props.data, props.kind))
const W = 340
const MOOD_NAME = ['很差', '不太好', '一般', '不错', '很好']
const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)']
const moodColor = (m: number) => `var(--m${Math.min(5, Math.max(1, Math.round(m)))})`

/** 统一成：类别 + 每组的数值 */
interface Model {
  by: string
  cats: { key: string; label: string }[]
  series: { label: string; groups: ChartGroup[] }[]
}
const model = computed<Model>(() => {
  const d = props.data
  if (d.type === 'dates') {
    const g = monthlyCounts(d)
    return { by: 'month', cats: g.map((x) => ({ key: x.key, label: x.label })), series: [{ label: '', groups: g }] }
  }
  const cats = d.series[0]?.groups.map((g) => ({ key: g.key, label: g.label })) ?? []
  return { by: d.group_by, cats, series: d.series }
})
const multi = computed(() => model.value.series.length > 1)
/** 标题：工具给的范围和分组，接上这种画法表示的指标 */
const title = computed(() => {
  if (props.data.type === 'dates') return props.data.title
  const metric = { bar: '天数', rank: '天数', line: '平均心情', mood: '心情构成', heatmap: '写到的日子' }[kind.value]
  return [props.data.title, metric].filter(Boolean).join(' · ')
})

/** 坐标轴上的短标签 */
function short(key: string, label: string, i: number): string {
  const by = model.value.by
  if (by === 'month' && /^\d{4}-\d{2}$/.test(key)) {
    const m = Number(key.slice(5))
    return i === 0 || m === 1 ? `${key.slice(0, 4)}.${m}` : `${m}月`
  }
  if (by === 'month' && /^\d{2}$/.test(key)) return `${Number(key)}月`
  if ((by === 'week' || by === 'day') && /^\d{4}-\d{2}-\d{2}$/.test(key)) return `${Number(key.slice(5, 7))}/${Number(key.slice(8))}`
  if (by === 'mood') return MOOD_NAME[Number(key) - 1] ?? key
  return [...label].length > 5 ? `${[...label].slice(0, 4).join('')}…` : label
}

/** 纵轴最大值取整：天数只用整数刻度（10 以内取偶数，中间那条线也是整数） */
function nice(max: number): number {
  if (max <= 10) return Math.max(2, Math.ceil(max / 2) * 2)
  const p = 10 ** Math.floor(Math.log10(max))
  for (const m of [1, 2, 2.5, 5, 10]) if (max <= m * p) return m * p
  return max
}

/** 柱子：底部方角，顶端 4px 圆角 */
function colPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return ''
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}
/** 横条：左边方角，右端 4px 圆角 */
function rowPath(x: number, y: number, w: number, h: number): string {
  if (w <= 0) return ''
  const r = Math.min(4, h / 2, w)
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`
}

/** 单组时朱红标出最高的（只有一个最高时） */
const maxIndex = computed(() => {
  if (multi.value || model.value.by === 'mood') return -1
  const v = model.value.series[0]?.groups.map((g) => g.days) ?? []
  const m = Math.max(...v)
  return m > 0 && v.filter((x) => x === m).length === 1 ? v.indexOf(m) : -1
})
function fillFor(si: number, gi: number): string {
  if (multi.value) return SERIES[si % 4]
  if (model.value.by === 'mood') return moodColor(Number(model.value.cats[gi]?.key))
  return gi === maxIndex.value ? 'var(--accent)' : SERIES[0]
}

// ---------- 柱状图 ----------
const bar = computed(() => {
  const m = model.value
  const H = 170
  const pad = { l: 30, r: 6, t: 10, b: 24 }
  const pw = W - pad.l - pad.r
  const ph = H - pad.t - pad.b
  const n = Math.max(1, m.cats.length)
  const ns = m.series.length
  const max = nice(Math.max(1, ...m.series.flatMap((s) => s.groups.map((g) => g.days))))
  const band = pw / n
  const bw = Math.max(1, Math.min(24, (band * 0.72) / ns))
  const step = Math.ceil(n / 7)
  return {
    H, pad, ph, max, band,
    ticks: [0, max / 2, max].map((v) => ({ v, y: pad.t + ph - (v / max) * ph, label: Number.isInteger(v) ? String(v) : v.toFixed(1) })),
    bars: m.series.flatMap((s, si) => s.groups.map((g, gi) => {
      const h = (g.days / max) * ph
      const x = pad.l + gi * band + (band - bw * ns - (ns - 1) * 2) / 2 + si * (bw + 2)
      return { si, gi, d: colPath(x, pad.t + ph - h, bw, h), fill: fillFor(si, gi) }
    })),
    labels: m.cats.map((c, i) => ({ i, x: pad.l + i * band + band / 2, text: short(c.key, c.label, i) })).filter((l) => l.i % step === 0),
  }
})

// ---------- 折线：平均心情 ----------
const line = computed(() => {
  const m = model.value
  const H = 170
  const pad = { l: 34, r: 10, t: 12, b: 24 }
  const pw = W - pad.l - pad.r
  const ph = H - pad.t - pad.b
  const n = Math.max(1, m.cats.length)
  const xAt = (i: number) => pad.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw)
  const yAt = (v: number) => pad.t + ph - ((v - 1) / 4) * ph
  const step = Math.ceil(n / 7)
  return {
    H, pad,
    ticks: [1, 3, 5].map((v) => ({ v, y: yAt(v), label: MOOD_NAME[v - 1] })),
    series: m.series.map((s, si) => {
      // 没有心情的组断开，不连线
      const segs: string[] = []
      let cur = ''
      s.groups.forEach((g, i) => {
        if (g.avg_mood == null) {
          if (cur) segs.push(cur)
          cur = ''
        } else cur += `${cur ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(g.avg_mood).toFixed(1)}`
      })
      if (cur) segs.push(cur)
      return {
        si,
        stroke: multi.value ? SERIES[si % 4] : 'var(--muted)',
        segs,
        dots: s.groups.map((g, gi) => ({ gi, x: xAt(gi), y: g.avg_mood == null ? null : yAt(g.avg_mood), fill: multi.value ? SERIES[si % 4] : moodColor(g.avg_mood ?? 3) }))
          .filter((d) => d.y != null),
      }
    }),
    hits: m.cats.map((_, i) => ({ i, x: xAt(i) - pw / n / 2, w: pw / n })),
    labels: m.cats.map((c, i) => ({ i, x: xAt(i), text: short(c.key, c.label, i) })).filter((l) => l.i % step === 0),
  }
})

// ---------- 横向排行 ----------
const rank = computed(() => {
  const m = model.value
  const ns = m.series.length
  const bh = ns === 1 ? 14 : Math.max(5, Math.min(9, 24 / ns))
  const rowH = ns === 1 ? 26 : bh * ns + (ns - 1) * 2 + 12
  const pad = { l: 74, r: 30, t: 4 }
  const pw = W - pad.l - pad.r
  const max = Math.max(1, ...m.series.flatMap((s) => s.groups.map((g) => g.days)))
  return {
    H: pad.t + rowH * m.cats.length + 4,
    rows: m.cats.map((c, gi) => {
      const y0 = pad.t + gi * rowH
      return {
        gi,
        y0,
        rowH,
        label: [...c.label].length > 6 ? `${[...c.label].slice(0, 5).join('')}…` : c.label,
        ly: y0 + rowH / 2,
        bars: m.series.map((s, si) => {
          const g = s.groups[gi]
          const w = ((g?.days ?? 0) / max) * pw
          const y = y0 + (rowH - (bh * ns + (ns - 1) * 2)) / 2 + si * (bh + 2)
          return { si, d: rowPath(pad.l, y, w, bh), fill: fillFor(si, gi), vx: pad.l + w + 4, vy: y + bh / 2, v: g?.days ?? 0 }
        }),
      }
    }),
  }
})

// ---------- 心情构成 ----------
const mood = computed(() => {
  const m = model.value
  const g = (m.series[0]?.groups ?? []).slice(0, 60)
  const rowH = 22
  const pad = { l: 74, r: 6, t: 4 }
  const pw = W - pad.l - pad.r
  const bh = 14
  return {
    H: pad.t + rowH * g.length + 4,
    rows: g.map((x, gi) => {
      const counts = x.moods ?? [0, 0, 0, 0, 0]
      const total = counts.reduce((a, b) => a + b, 0)
      const y = pad.t + gi * rowH + (rowH - bh) / 2
      const nonzero = counts.filter((c) => c > 0).length
      const usable = pw - Math.max(0, nonzero - 1) * 2
      let x0 = pad.l
      const segs = counts.map((c, k) => {
        if (!c || !total) return null
        const w = (c / total) * usable
        const seg = { k, x: x0, w, fill: moodColor(k + 1) }
        x0 += w + 2
        return seg
      }).filter((s): s is { k: number; x: number; w: number; fill: string } => !!s)
      return { gi, y, bh, total, segs, label: short(m.cats[gi].key, m.cats[gi].label, gi), ly: y + bh / 2 }
    }),
    pad,
    pw,
  }
})

// ---------- 日历格子 ----------
interface Cell { date: string; x: number; y: number; fill: string; hit: boolean; mood: number | null }
const heat = computed(() => {
  const d = props.data
  const hits = new Map<string, number | null>()
  let from: string
  let to: string
  if (d.type === 'dates') {
    for (const x of d.dates) hits.set(x.date, x.mood)
    from = d.from
    to = d.to
  } else {
    const gs = d.series[0]?.groups ?? []
    for (const g of gs) if (g.days > 0) hits.set(g.key, g.avg_mood)
    from = gs[0]?.key ?? ''
    to = gs[gs.length - 1]?.key ?? ''
  }
  // 最多画最近 36 个月
  const months: string[] = []
  let y = Number(to.slice(0, 4))
  let mo = Number(to.slice(5, 7))
  while (months.length < HEATMAP_MONTHS) {
    const k = `${y}-${String(mo).padStart(2, '0')}`
    if (k < from.slice(0, 7)) break
    months.unshift(k)
    if (--mo < 1) { mo = 12; y-- }
  }
  const labelW = 44
  const cell = (W - labelW - 2) / 31
  const size = Math.max(3, cell - 1.5)
  const rowH = size + 2.5
  const cells: Cell[] = []
  months.forEach((k, r) => {
    const days = new Date(Number(k.slice(0, 4)), Number(k.slice(5)), 0).getDate()
    for (let day = 1; day <= days; day++) {
      const date = `${k}-${String(day).padStart(2, '0')}`
      const hit = hits.has(date)
      const md = hits.get(date) ?? null
      cells.push({ date, x: labelW + (day - 1) * cell, y: 4 + r * rowH, hit, mood: md, fill: hit ? (md != null ? moodColor(md) : 'var(--s1)') : 'var(--line)' })
    }
  })
  return {
    H: 4 + months.length * rowH + 4,
    size,
    cells,
    rows: months.map((k, r) => {
      const m = Number(k.slice(5))
      return { y: 4 + r * rowH + size / 2, text: r === 0 || m === 1 ? `${k.slice(0, 4)}.${m}` : `${m}月` }
    }),
    total: hits.size,
  }
})

// ---------- 点选显示数值 ----------
const sel = ref<number | null>(null)
function fmtAvg(v: number | null) {
  return v == null ? '没记心情' : `平均心情 ${v.toFixed(1)}`
}
const info = computed(() => {
  const i = sel.value
  const m = model.value
  if (i == null || !m.cats[i]) return ''
  const name = m.cats[i].label
  if (kind.value === 'mood') {
    const c = m.series[0].groups[i].moods ?? []
    const t = c.reduce((a, b) => a + b, 0)
    return t ? `${name}：${c.map((n, k) => (n ? `${MOOD_NAME[k]} ${n} 天` : '')).filter(Boolean).join('，')}` : `${name}：没记心情`
  }
  const parts = m.series.map((s) => {
    const g = s.groups[i]
    const v = kind.value === 'line' ? fmtAvg(g.avg_mood) : `${g.days} 天${g.avg_mood != null && props.data.type === 'groups' ? `，${fmtAvg(g.avg_mood)}` : ''}`
    return multi.value ? `${s.label} ${v}` : v
  })
  return `${name}：${parts.join('；')}`
})
const hint = computed(() => (kind.value === 'heatmap' ? '点有颜色的格子打开那天的日记' : '点图上的柱子、点或行看数值'))

function openDay(c: Cell) {
  if (c.hit && index.get(c.date)) void router.push(`/entry/${c.date}`)
}

// ---------- 数据表 ----------
const table = computed(() => {
  const m = model.value
  return {
    head: m.series.length > 1 ? m.series.map((s) => s.label) : ['天数'],
    showAvg: props.data.type === 'groups',
    rows: m.cats.map((c, i) => ({
      label: c.label,
      vals: m.series.map((s) => s.groups[i]?.days ?? 0),
      avgs: m.series.map((s) => s.groups[i]?.avg_mood ?? null),
    })),
  }
})
</script>

<template>
  <figure class="chart" :class="kind">
    <figcaption class="title">{{ title }}</figcaption>
    <div v-if="multi" class="legend">
      <span v-for="(s, si) in model.series" :key="si"><i :style="{ background: SERIES[si % 4] }" />{{ s.label }}</span>
    </div>
    <div v-else-if="kind === 'mood' || (kind === 'heatmap' && heat.cells.some((c) => c.mood != null))" class="legend">
      <span v-for="(n, k) in MOOD_NAME" :key="k"><i :style="{ background: `var(--m${k + 1})` }" />{{ n }}</span>
      <span v-if="kind === 'heatmap'"><i :style="{ background: 'var(--line)' }" />没提到</span>
    </div>

    <!-- 柱状图 -->
    <svg v-if="kind === 'bar'" :viewBox="`0 0 ${W} ${bar.H}`" role="img" :aria-label="title">
      <g class="grid">
        <line v-for="t in bar.ticks" :key="t.v" :x1="bar.pad.l" :x2="W - bar.pad.r" :y1="t.y" :y2="t.y" />
      </g>
      <text v-for="t in bar.ticks" :key="'t' + t.v" class="tick" :x="bar.pad.l - 6" :y="t.y + 3.5" text-anchor="end">{{ t.label }}</text>
      <path v-for="b in bar.bars" :key="`${b.si}-${b.gi}`" :d="b.d" :style="{ fill: b.fill }" :class="{ dim: sel != null && sel !== b.gi }" />
      <text v-for="l in bar.labels" :key="'x' + l.i" class="tick" :x="l.x" :y="bar.H - 8" text-anchor="middle">{{ l.text }}</text>
      <rect v-for="(_, i) in model.cats" :key="'h' + i" class="hit" :x="bar.pad.l + i * bar.band" :y="0" :width="bar.band" :height="bar.H"
        @click="sel = sel === i ? null : i" />
    </svg>

    <!-- 折线：平均心情 -->
    <svg v-else-if="kind === 'line'" :viewBox="`0 0 ${W} ${line.H}`" role="img" :aria-label="title">
      <g class="grid">
        <line v-for="t in line.ticks" :key="t.v" :x1="line.pad.l" :x2="W - line.pad.r" :y1="t.y" :y2="t.y" />
      </g>
      <text v-for="t in line.ticks" :key="'t' + t.v" class="tick" :x="line.pad.l - 6" :y="t.y + 3.5" text-anchor="end">{{ t.label }}</text>
      <g v-for="s in line.series" :key="s.si">
        <path v-for="(d, k) in s.segs" :key="k" :d="d" class="stroke" :style="{ stroke: s.stroke }" />
        <circle v-for="p in s.dots" :key="p.gi" :cx="p.x" :cy="p.y!" :r="sel === p.gi ? 5.5 : 4" class="dot" :style="{ fill: p.fill }" />
      </g>
      <text v-for="l in line.labels" :key="'x' + l.i" class="tick" :x="l.x" :y="line.H - 8" text-anchor="middle">{{ l.text }}</text>
      <rect v-for="h in line.hits" :key="'h' + h.i" class="hit" :x="h.x" :y="0" :width="h.w" :height="line.H" @click="sel = sel === h.i ? null : h.i" />
    </svg>

    <!-- 横向排行 -->
    <svg v-else-if="kind === 'rank'" :viewBox="`0 0 ${W} ${rank.H}`" role="img" :aria-label="title">
      <g v-for="r in rank.rows" :key="r.gi" :class="{ dim: sel != null && sel !== r.gi }">
        <text class="lab" :x="70" :y="r.ly + 4" text-anchor="end">{{ r.label }}</text>
        <template v-for="b in r.bars" :key="b.si">
          <path :d="b.d" :style="{ fill: b.fill }" />
          <text class="val" :x="b.vx" :y="b.vy + 3.5">{{ b.v }}</text>
        </template>
        <rect class="hit" x="0" :y="r.y0" :width="W" :height="r.rowH" @click="sel = sel === r.gi ? null : r.gi" />
      </g>
    </svg>

    <!-- 心情构成 -->
    <svg v-else-if="kind === 'mood'" :viewBox="`0 0 ${W} ${mood.H}`" role="img" :aria-label="title">
      <defs>
        <clipPath v-for="r in mood.rows" :id="`${uid}-${r.gi}`" :key="r.gi">
          <rect :x="mood.pad.l" :y="r.y" :width="mood.pw" :height="r.bh" rx="4" />
        </clipPath>
      </defs>
      <g v-for="r in mood.rows" :key="r.gi" :class="{ dim: sel != null && sel !== r.gi }">
        <text class="lab" :x="70" :y="r.ly + 4" text-anchor="end">{{ r.label }}</text>
        <g v-if="r.total" :clip-path="`url(#${uid}-${r.gi})`">
          <rect v-for="s in r.segs" :key="s.k" :x="s.x" :y="r.y" :width="s.w" :height="r.bh" :style="{ fill: s.fill }" />
        </g>
        <text v-else class="val" :x="mood.pad.l" :y="r.ly + 3.5">没记心情</text>
        <rect class="hit" x="0" :y="r.y - 4" :width="W" :height="r.bh + 8" @click="sel = sel === r.gi ? null : r.gi" />
      </g>
    </svg>

    <!-- 日历格子 -->
    <svg v-else :viewBox="`0 0 ${W} ${heat.H}`" role="img" :aria-label="`${title}，共 ${heat.total} 天`">
      <text v-for="(r, i) in heat.rows" :key="i" class="tick" :x="38" :y="r.y + 3.5" text-anchor="end">{{ r.text }}</text>
      <rect v-for="c in heat.cells" :key="c.date" :x="c.x" :y="c.y" :width="heat.size" :height="heat.size" rx="1.5"
        :style="{ fill: c.fill }" :class="{ on: c.hit }" @click="openDay(c)">
        <title>{{ c.date }}{{ c.hit ? (c.mood != null ? `，心情 ${c.mood}` : '') : '' }}</title>
      </rect>
    </svg>

    <p class="info" :class="{ muted: !info }">{{ info || hint }}</p>
    <details v-if="kind !== 'heatmap'" class="data">
      <summary>看数据</summary>
      <table>
        <thead>
          <tr>
            <th></th>
            <th v-for="h in table.head" :key="h">{{ h }}</th>
            <th v-if="table.showAvg && !multi">平均心情</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in table.rows" :key="i">
            <td>{{ r.label }}</td>
            <td v-for="(v, k) in r.vals" :key="k" class="num">{{ v }}</td>
            <td v-if="table.showAvg && !multi" class="num">{{ r.avgs[0] == null ? '—' : r.avgs[0].toFixed(1) }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </figure>
</template>

<style scoped>
.chart { margin: 14px 0; padding: 12px 12px 8px; border-radius: 14px; background: var(--surface); }
.title { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--muted); }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0 0 6px; font-size: 12px; color: var(--ink); }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; }
svg { display: block; width: 100%; height: auto; overflow: visible; font-family: var(--num); }
.grid line { stroke: var(--line); stroke-width: 1; }
.tick { font-size: 10px; fill: var(--muted); font-family: var(--sans); }
.lab { font-size: 12px; fill: var(--ink); font-family: var(--sans); }
.val { font-size: 11px; fill: var(--muted); }
.stroke { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
/* 点外面一圈底色，压在线上也看得清 */
.dot { stroke: var(--surface); stroke-width: 2; }
.hit { fill: transparent; cursor: pointer; }
.dim { opacity: 0.45; }
.heatmap rect.on { cursor: pointer; }
.info { min-height: 1.5em; margin: 6px 0 0; font-size: 13px; color: var(--ink); }
.info.muted { color: var(--faint); font-size: 12px; }
.data { margin-top: 4px; font-size: 12px; color: var(--muted); }
.data summary { cursor: pointer; padding: 4px 0; }
.data table { width: 100%; border-collapse: collapse; margin-top: 4px; }
.data th, .data td { padding: 3px 4px; border-bottom: 1px solid var(--line); text-align: left; font-weight: 400; }
.data td.num, .data th:not(:first-child) { text-align: right; font-family: var(--num); font-variant-numeric: tabular-nums; }
</style>
