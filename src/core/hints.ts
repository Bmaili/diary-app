/**
 * 小提示的句库（2026-10-10 加入）：首页统计行下面的一句，和写日记提醒通知的正文，共用这一套。
 * 按时段、节令、日历和你自己的日记状态挑一句。同一天、同一时段固定一句（按日期和时段算哈希），
 * 来回切页面、重排通知时不会变。纯函数，不联网（天气以后再接）。
 *
 * 挑选顺序：
 * 1. 今天已经写过（只在首页）：连续写到 7 / 30 / 100 / 365 天说一句，否则说“写好了”一类的话；
 * 2. 节日 → 节气当天 → 农历初一、十五、十六 → 年末、月末、月初：当天必定用这一类；
 * 3. 其余日子：一半概率用“软条件”的句子（那年今日、隔了一阵没写、假期、调休、周末、周一、周五），
 *    一半概率从时段、季节、通用三类里挑。
 * 标了 night 的句子只在夜里（19 点以后到“一天开始”的时刻）出现。
 * 不写“你已经几天没写了”这种让人愧疚的话。
 */
import { lunarDay, seasonOf, type Season } from './lunar'
import { addDays, parseYmd } from './time'

export type Slot = 'dawn' | 'morning' | 'afternoon' | 'dusk' | 'night' | 'late'

type Line = string | { t: string; night: true }

const GENERAL: Line[] = [
  '片言只语，也是光阴。',
  '哪怕一句话，也是今天的一页。',
  '今日之事，今日记之。',
  '一句话就够，纸不嫌短。',
  '浮生如寄，字有归处。',
  '浮生几何，一笔一记。',
  '小事最容易忘，也最值得记。',
  '今天吃了什么、见了谁，记一笔就好。',
  '多年后翻到这一页，会想起今天。',
  '不必写得好，写下来就好。',
  '今天有什么想留住的？',
  '一个画面，一句话，一个名字，都可以。',
  '寻常日子，也值得一记。',
  '今天的事，明天就会淡一些。',
  '写给以后的自己，几个字就够。',
  '字不在多，记得就好。',
  '今天有什么值得一笑的事？',
  '一句流水账，也是好日记。',
  '把今天折一角，夹进这里。',
  '日子是一页一页过的。',
  '好事坏事，写下来都轻一些。',
  '今天有谁让你想起？',
  '写几个字，给今天一个交代。',
  '记下今天，就多活了一遍。',
  '光阴易逝，纸上可留。',
]

const SLOTS: Record<Slot, Line[]> = {
  dawn: ['一早写几个字，给今天开个头。', '昨夜的梦还记得吗？趁早写下来。', '晨起无事，记下今天的打算。', '朝露未干，先写一笔。'],
  morning: ['忙里偷闲，写一句也好。', '上午过半，今天怎么样？'],
  afternoon: ['午后得闲，写两句。', '半日已过，留个记号。', '一杯茶的工夫，就够写一段。', '日影西斜之前，记一笔。'],
  dusk: ['日落时分，回头看看今天。', '下班路上想到什么，先记下来。', '暮色将至，给今天收个尾。', '炊烟起时，记一笔今天。'],
  night: [
    '灯下写几个字，今天便有了着落。', '茶凉之前，写一句吧。', '一天忙完了，和自己说几句。', '睡前三行，今天就完整了。',
    '若有月色，就写进来。', '星河在天，灯下落笔。', '举头望月之前，先低头写几行。',
  ],
  late: ['夜深了，写一句再睡。', '夜里安静，正好落笔。', '今天还没过完，写完这句再睡。', '夜阑人静，最适合和自己说话。', '月上中天，写完就睡吧。'],
}

const SEASONS: Record<Season, Line[]> = {
  spring: ['春天的事，最容易一晃而过。', '春日迟迟，写一句。', { t: '春夜微凉，正好写字。', night: true }],
  summer: ['夏天日子长，写一段也不嫌多。', { t: '夏夜有风，写进日记里。', night: true }],
  autumn: ['秋天适合回头看看。', '秋高气爽，记一笔。', { t: '秋夜月明，写一句。', night: true }],
  winter: ['冬日里，写字是件暖和的事。', { t: '冬夜长，慢慢写。', night: true }],
}

/** 键：lunar.ts 的节日名，或公历的 元旦 / 劳动节 / 国庆 */
const FESTIVALS: Record<string, Line[]> = {
  元旦: ['新年第一页，写点什么吧。', '一年开头，许个愿也好。'],
  腊八: ['腊八了，年味近了。'],
  除夕: ['除夕了，这一年的最后一页。', '守岁之前，给这一年写个结尾。'],
  春节: ['新春第一笔，写给这一年。', '过年了，今天见了谁？'],
  元宵: ['元宵灯月，记一笔。'],
  劳动节: ['劳动节，歇一歇，写几句。'],
  端午: ['端午安康，今天吃粽子了吗？'],
  七夕: ['七夕，银河两岸，写写身边的人。'],
  中秋: ['中秋月圆，今天和谁一起过？', '月到中秋分外明，写一句。'],
  国庆: ['国庆假期，去了哪儿？'],
  重阳: ['重阳登高，记一笔。', '今天重阳，给家里的长辈打电话了吗？'],
}

const JIEQI: Record<string, string> = {
  立春: '立春了，新的一年从这页开始。', 雨水: '雨水，草木要醒了。', 惊蛰: '惊蛰，春雷一响，万物都动起来了。',
  春分: '春分，昼夜一样长。', 清明: '清明时节，想起了谁？', 谷雨: '谷雨，春天的最后一程。',
  立夏: '立夏了，日子变长，可写的也多了。', 小满: '小满，未满也好。', 芒种: '芒种，再忙也记得写一句。',
  夏至: '夏至，一年里白天最长的一天。', 小暑: '小暑，蝉声渐起。', 大暑: '大暑，最热的日子，写几个字消消暑。',
  立秋: '立秋了，夏天的事趁早记下。', 处暑: '处暑，暑气渐消。', 白露: '白露，早晚凉了。',
  秋分: '秋分，秋天过了一半。', 寒露: '寒露，添件衣服，写一句。', 霜降: '霜降，秋天的最后一个节气。',
  立冬: '立冬了，今年的冬天从这一页开始。', 小雪: '小雪，天冷了，宜在屋里写字。', 大雪: '大雪，围炉写几句。',
  冬至: '冬至，夜最长，正好写日记。', 小寒: '小寒，一年快到头了。', 大寒: '大寒，这一年的最后一个节气。',
}

const LUNAR_DAYS: Record<string, Line[]> = {
  初一: ['一个月从这里开头。', '新月初生，一切从头。'],
  十五: ['月圆之日，写写想念的人。', { t: '月圆之夜，写一句。', night: true }],
  十六: ['十五的月亮十六圆。'],
}

const CAL = {
  yearEnd: ['一年最后一天，给这一年写个结尾。'],
  monthEnd: ['这个月最后一天，回头看看这一个月。'],
  monthStart: ['新的一个月，从这页开始。'],
}

const SOFT = {
  weekend: ['周末的日子最容易记混，趁还记得写下来。', '周末过得怎么样？记一笔。', '难得清闲，多写几句也无妨。'],
  holiday: ['假期的日子过得快，一天记一笔。', '去了哪儿，见了谁？假期最值得记。'],
  workday: ['调休上班，辛苦了，给今天留个记号。'],
  monday: ['新的一周，写个开头。'],
  friday: ['一周过完了，记一笔。'],
  gap: ['隔了些日子，从今天接着写就好。', '不用补，从今天写起。'],
}

const WROTE: Line[] = [
  '今天已落一笔。晚些想起什么，还可以再添。', '今天这页写好了。', '写好了，今天有了着落。', '今日已记，可以安心过完今天了。',
  { t: '今天记下了，明天见。', night: true }, { t: '今天记下了，安心睡吧。', night: true },
]

/** 统计行已经说了“连续写了 N 天”，这里不再重复数字 */
const MILESTONES: Record<number, string> = {
  7: '七日不辍，好习惯。', 30: '一月不辍，日子都在纸上了。', 100: '百日不辍，难得。', 365: '一年不辍，这一年都在纸上了。',
}

const CN_NUM = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十']

/** 现在算哪个时段。早于“一天开始”的时刻还算前一天的深夜 */
export function slotOf(hour: number, cutoffHour = 4): Slot {
  if (hour < cutoffHour || hour >= 23) return 'late'
  if (hour < 5) return 'late'
  if (hour < 9) return 'dawn'
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  if (hour < 19) return 'dusk'
  return 'night'
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

function usable(lines: Line[], slot: Slot): string[] {
  const nightly = slot === 'night' || slot === 'late'
  return lines.flatMap((l) => (typeof l === 'string' ? [l] : nightly ? [l.t] : []))
}

export interface HintContext {
  /** 日记日期（已按“一天从几点开始”换算） */
  date: string
  /** 现在（或通知发出时）是几点 */
  hour: number
  cutoffHour?: number
  /** 首页：今天写过没有、连续几天（含今天）、几年前的今天有日记（0 表示没有）、距离上一篇几天 */
  wrote?: boolean
  streak?: number
  yearsAgo?: number
  gapDays?: number
  /** 通知里用：不说跟日记状态有关的话 */
  forNotice?: boolean
}

export interface Hint {
  text: string
  /** 这句自己就点明了今天是什么日子（节日、节气）：通知里不用再加“今天寒露。”的前缀 */
  namesDay: boolean
}

export function pickHint(c: HintContext): Hint {
  const slot = slotOf(c.hour, c.cutoffHour)
  const key = `${c.date}|${slot}`
  const choose = (lines: string[], salt: string) => lines[hash(key + salt) % lines.length]
  const l = lunarDay(c.date)
  const md = c.date.slice(5)

  if (!c.forNotice && c.wrote) {
    const m = MILESTONES[c.streak ?? 0]
    return { text: m ?? choose(usable(WROTE, slot), 'w'), namesDay: false }
  }

  // 当天必定用的几类
  const fest = md === '01-01' ? '元旦' : md === '05-01' ? '劳动节' : md === '10-01' ? '国庆' : l.festival
  const tiers: [Line[] | undefined, boolean][] = [
    [fest ? FESTIVALS[fest] : undefined, true],
    [l.jieqi && JIEQI[l.jieqi] ? [JIEQI[l.jieqi]] : undefined, true],
    // 初一十五这几句不点明日子：通知里照常带“今天农历九月初一。”的前缀
    [LUNAR_DAYS[l.day], false],
    [md === '12-31' ? CAL.yearEnd : addDays(c.date, 1).endsWith('-01') ? CAL.monthEnd : md.endsWith('-01') ? CAL.monthStart : undefined, false],
  ]
  for (const [lines, namesDay] of tiers) {
    const ok = lines ? usable(lines, slot) : []
    if (ok.length) return { text: choose(ok, 't'), namesDay }
  }

  // 软条件：一半概率用
  const soft: string[] = []
  if (!c.forNotice) {
    const n = c.yearsAgo ?? 0
    if (n > 0) soft.push(`${n <= 10 ? `${CN_NUM[n]}年` : `${n} 年`}前的今天你也写过，写完今天的，再去看看那天。`)
    if ((c.gapDays ?? 0) >= 7) soft.push(...SOFT.gap)
  }
  const wd = parseYmd(c.date).getDay()
  if (l.holiday) soft.push(...(l.holiday.off ? SOFT.holiday : SOFT.workday))
  else if (wd === 0 || wd === 6) soft.push(...SOFT.weekend)
  else if (wd === 1) soft.push(...SOFT.monday)
  else if (wd === 5) soft.push(...SOFT.friday)
  if (soft.length && hash(key + 's') % 2 === 0) return { text: choose(soft, 'p'), namesDay: false }

  const mix = [...usable(SLOTS[slot], slot), ...usable(SEASONS[seasonOf(l.term)], slot), ...usable(GENERAL, slot)]
  return { text: choose(mix, 'm'), namesDay: false }
}

/** 测试用：全部句子 */
export function allLines(): string[] {
  const all: Line[] = [
    ...GENERAL, ...Object.values(SLOTS).flat(), ...Object.values(SEASONS).flat(), ...Object.values(FESTIVALS).flat(),
    ...Object.values(JIEQI), ...Object.values(LUNAR_DAYS).flat(), ...Object.values(CAL).flat(), ...Object.values(SOFT).flat(),
    ...WROTE, ...Object.values(MILESTONES),
  ]
  return all.map((x) => (typeof x === 'string' ? x : x.t))
}
