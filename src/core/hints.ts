/**
 * 小提示（2026-10-10 加入，同日改成分层抽取）：首页统计行下面的一句，和写日记提醒通知的正文，共用这一套。
 * 目标是“不在预期之内”：素材来自七十二候、十二时辰、节气交节的时刻、你自己的日记，偶尔有彩蛋。
 * 纯函数，不联网。随机数由调用方给的 seed 决定：同一个 seed 永远是同一句（首页的换句节奏见 hintService.ts）。
 *
 * 抽取顺序（每一步按概率决定用不用，不用就往下走）：
 * 1. 今天写过（只在首页）：连续写到 7 / 30 / 100 / 365 天，直接说那一句；
 *    “第 N 篇”“写了三段”“满几万字”这类写后的话（调用方算好传进来）一半概率出现。
 * 2. 彩蛋：碰上特殊的日子或时刻（零点前后、闰月、晦日、2 月 29 日、节日逢周末、回文日期、月日相同）30%；
 *    平时 3% 出一道写作小题。
 * 3. 节日、节气、农历初一十五十六、年末月末月初：60% 用这一天的句子；其余时候只从节令层（七十二候、时辰、交节）挑。
 * 4. 平时分层：节令 35%（七十二候、时辰、交节；七十二候一候 5 天，权重低一些）、你的日记 30%、
 *    写过以后“写过了”那组 25%，剩下的给时段、季节、通用、周末假期（没有素材的层，份额归到这一层）。
 *    每层里先按权重选一类，再在这一类里挑一句，所以句子少的类不会被淹没。
 * 今天写过以后，所有层都照常参与，只是去掉催人写的句子（含“写”“记”“笔”的）；“写过了”那组单独占一份。
 * 不写“你已经几天没写了”这种让人愧疚的话。
 */
import { lunarDay, nextJieqi, pentad, seasonOf, type Season } from './lunar'
import { addDays, parseYmd } from './time'

export type Slot = 'dawn' | 'morning' | 'afternoon' | 'dusk' | 'night' | 'late'

/** when：只在白天（清晨到傍晚）/ 傍晚 / 夜里（19 点以后到“一天开始”的时刻）出现；不写就是任何时候 */
type Line = string | { t: string; when: 'day' | 'dusk' | 'night' }
/** 一类句子和它的权重 */
interface Cat { w: number; lines: string[] }

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
  spring: ['春天的事，最容易一晃而过。', '春日迟迟，写一句。', { t: '春夜微凉，正好写字。', when: 'night' }],
  summer: ['夏天日子长，写一段也不嫌多。', { t: '夏夜有风，写进日记里。', when: 'night' }],
  autumn: ['秋天适合回头看看。', '秋高气爽，记一笔。', { t: '秋夜月明，写一句。', when: 'night' }],
  winter: ['冬日里，写字是件暖和的事。', { t: '冬夜长，慢慢写。', when: 'night' }],
}

const day = (t: string): Line => ({ t, when: 'day' })
const dusk = (t: string): Line => ({ t, when: 'dusk' })
const night = (t: string): Line => ({ t, when: 'night' })

/** 键：lunar.ts 的节日名，或公历的 元旦 / 劳动节 / 国庆 */
const FESTIVALS: Record<string, Line[]> = {
  元旦: [day('新年第一页，写点什么吧。'), day('一年开头，许个愿也好。'), day('新年第一天，今天见了谁？'), night('新年的第一个夜晚，记下今天。')],
  腊八: ['腊八了，年味近了。', day('腊八粥喝了吗？'), night('腊八夜里，离过年又近了一步。')],
  除夕: [day('除夕了，这一年的最后一页。'), day('年夜饭准备得怎么样？'), night('守岁之前，给这一年写个结尾。'), night('爆竹声中一岁除。')],
  春节: ['新春第一笔，写给这一年。', day('过年了，今天见了谁？'), day('拜年走了几家？'), night('新年第一夜，灯火还亮着。')],
  元宵: [day('元宵节，汤圆吃了吗？'), night('元宵灯月，记一笔。'), night('东风夜放花千树。')],
  劳动节: [day('劳动节，歇一歇，写几句。'), day('假期第一天，去哪儿了？'), night('假期的第一个晚上，记下今天。')],
  端午: [day('端午安康，今天吃粽子了吗？'), day('端午，艾草挂上了吗？'), night('端午的夜，写一句。')],
  七夕: [day('七夕，写写身边的人。'), night('七夕，银河两岸，写写身边的人。'), night('纤云弄巧，飞星传恨。')],
  中秋: [
    day('中秋团圆，今天和谁一起过？'), day('中秋了，月饼吃了吗？'), dusk('暮色起时，月亮快上来了。'),
    night('月到中秋分外明，写一句。'), night('今夜月色，最宜落笔。'), night('但愿人长久，千里共婵娟。'),
  ],
  国庆: [day('国庆假期，去了哪儿？'), day('国庆，今天见了谁？'), night('假期的夜晚，记下今天去过的地方。')],
  重阳: [day('重阳登高，记一笔。'), day('今天重阳，给家里的长辈打电话了吗？'), night('每逢佳节倍思亲，写写想念的人。')],
}

const JIEQI: Record<string, Line[]> = {
  立春: ['立春了，新的一年从这页开始。', day('春打六九头，冷也快到头了。'), night('立春夜，风里有了一点暖意。')],
  雨水: ['雨水，草木要醒了。', '好雨知时节，当春乃发生。'],
  惊蛰: ['惊蛰，春雷一响，万物都动起来了。', '惊蛰到，虫子们醒了。'],
  春分: ['春分，昼夜一样长。', '春分，春天过了一半。'],
  清明: ['清明时节，想起了谁？', day('清明，天清地明。')],
  谷雨: ['谷雨，春天的最后一程。', day('谷雨，牡丹快开了。')],
  立夏: ['立夏了，日子变长，可写的也多了。', day('绿树阴浓夏日长。')],
  小满: ['小满，未满也好。', '小满，麦粒渐渐饱满。'],
  芒种: ['芒种，再忙也记得写一句。', day('芒种，有芒的麦子快收，有芒的稻子可种。')],
  夏至: [day('夏至，一年里白天最长的一天。'), night('夏至的夜，是一年里最短的夜。')],
  小暑: ['小暑，蝉声渐起。', '小暑，热起来了。'],
  大暑: ['大暑，最热的日子，写几个字消消暑。', '大暑，心静自然凉。'],
  立秋: ['立秋了，夏天的事趁早记下。', '立秋，一叶知秋。'],
  处暑: ['处暑，暑气渐消。', '处暑，热到头了。'],
  白露: [day('白露，早晚凉了。'), night('露从今夜白，月是故乡明。')],
  秋分: ['秋分，秋天过了一半。', '秋分，昼夜又一样长了。'],
  寒露: ['寒露，添件衣服，写一句。', day('寒露，菊花快开了。')],
  霜降: ['霜降，秋天的最后一个节气。', day('霜降，草木开始黄落。'), night('霜降夜，记得添被。')],
  立冬: ['立冬了，今年的冬天从这一页开始。', day('立冬，北方人要吃饺子了。')],
  小雪: [day('小雪，天冷了，宜在屋里写字。'), night('晚来天欲雪，能饮一杯无？')],
  大雪: ['大雪，围炉写几句。', day('大雪，瑞雪兆丰年。')],
  冬至: [day('冬至，一年里白天最短的一天。'), night('冬至，夜最长，正好写日记。'), '冬至大如年，饺子还是汤圆？'],
  小寒: ['小寒，一年快到头了。', '小寒，数九寒天正冷。'],
  大寒: ['大寒，这一年的最后一个节气。', '大寒过后，就是春天。'],
}

const LUNAR_DAYS: Record<string, Line[]> = {
  初一: ['一个月从这里开头。', '新月初生，一切从头。'],
  十五: ['月圆之日，写写想念的人。', night('月圆之夜，写一句。')],
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
  '今天的事，已经交给纸了。', '写下了，今天就不会走丢。', '落笔为凭，今天有据可查了。',
  night('今天记下了，明天见。'), night('今天记下了，安心睡吧。'), night('字已落定，灯可以熄了。'),
]

/** 统计行已经说了“连续写了 N 天”，这里不再重复数字 */
const MILESTONES: Record<number, string> = {
  7: '七日不辍，好习惯。', 30: '一月不辍，日子都在纸上了。', 100: '百日不辍，难得。', 365: '一年不辍，这一年都在纸上了。',
}

/** 十二时辰：子时从 23 点开始 */
const SHICHEN: { zhi: string; lines: string[] }[] = [
  { zhi: '子', lines: ['子时了，新的一天在门外。', '夜半无声，正好和自己说话。'] },
  { zhi: '丑', lines: ['丑时了，夜色正浓。', '鸡鸣之前，写完就睡吧。'] },
  { zhi: '寅', lines: ['寅时，天快亮了。', '平旦将至，最深的夜已经过去。'] },
  { zhi: '卯', lines: ['卯时日出，给今天开个头。', '日出了，昨夜的梦还记得吗？'] },
  { zhi: '辰', lines: ['辰时，早饭吃了吗？', '一日之计在于晨。'] },
  { zhi: '巳', lines: ['巳时，日头快到中天了。', '隅中时分，忙里偷闲写一句。'] },
  { zhi: '午', lines: ['午时，日正当中。', '日中则昃，半日已过。'] },
  { zhi: '未', lines: ['未时，日头偏西了。', '午后日昳，适合发会儿呆。'] },
  { zhi: '申', lines: ['申时，该喝杯茶了。', '晡时，下午过半了。'] },
  { zhi: '酉', lines: ['酉时日入，回头看看今天。', '日入而息，给今天收个尾。'] },
  { zhi: '戌', lines: ['戌时，掌灯了。', '黄昏过后，灯下落笔。'] },
  { zhi: '亥', lines: ['亥时人定，夜深人静。', '人定之时，写一句再睡。'] },
]

export function shichenOf(hour: number): number {
  return Math.floor(((hour + 1) % 24) / 2)
}

/** 七十二候的白话，键是 lunar-javascript 给的物候原文 */
export const PENTAD_GLOSS: Record<string, string> = {
  东风解冻: '东风吹来，冰开始化了', 蛰虫始振: '冬眠的虫子在洞里动了', 鱼陟负冰: '鱼游上水面，背着碎冰',
  獭祭鱼: '水獭把捉到的鱼一排排摆在岸上', 候雁北: '大雁往北飞了', 草木萌动: '草木开始发芽',
  桃始华: '桃花开了', 仓庚鸣: '黄鹂开始叫了', 鹰化为鸠: '古人以为，鹰变成了布谷鸟',
  玄鸟至: '燕子回来了', 雷乃发声: '开始打雷了', 始电: '开始有闪电了',
  桐始华: '泡桐开花了', 田鼠化为鴽: '古人以为，田鼠变成了鹌鹑', 虹始见: '雨后能看见彩虹了',
  萍始生: '浮萍长出来了', 鸣鸠拂其羽: '布谷鸟梳理羽毛，催人播种', 戴胜降于桑: '戴胜鸟落在桑树上',
  蝼蝈鸣: '蝼蛄开始叫了', 蚯蚓出: '蚯蚓钻出地面', 王瓜生: '王瓜的藤蔓长起来了',
  苦菜秀: '苦菜长得正茂', 靡草死: '喜阴的细草枯了', 麦秋至: '麦子熟了',
  螳螂生: '小螳螂孵出来了', 鵙始鸣: '伯劳鸟开始叫了', 反舌无声: '百舌鸟不叫了',
  鹿角解: '鹿角开始脱落', 蜩始鸣: '知了开始叫了', 半夏生: '半夏这味草药长出来了',
  温风至: '吹来的风都是热的', 蟋蟀居壁: '蟋蟀躲到墙根下避暑', 鹰始挚: '小鹰开始学着捕猎',
  腐草为萤: '古人以为，萤火虫是腐草变的', 土润溽暑: '土地潮湿，天气闷热', 大雨行时: '常有大雨',
  凉风至: '凉风来了', 白露降: '清晨有露水了', 寒蝉鸣: '寒蝉开始叫了',
  鹰乃祭鸟: '鹰把捕到的鸟摆开，像在祭祀', 天地始肃: '天地间有了肃杀之气', 禾乃登: '庄稼成熟了',
  鸿雁来: '大雁从北方飞来', 玄鸟归: '燕子南归了', 群鸟养羞: '鸟儿开始囤粮过冬',
  雷始收声: '不再打雷了', 蛰虫坯户: '虫子开始封洞，准备冬眠', 水始涸: '河水开始变浅',
  鸿雁来宾: '最后一批大雁也到了', 雀入大水为蛤: '古人以为，雀鸟入海变成了蛤蜊', 菊有黄花: '菊花开了',
  豺乃祭兽: '豺把猎物摆开，像在祭祀', 草木黄落: '草木变黄，叶子落了', 蛰虫咸俯: '虫子都躲进洞里不动了',
  水始冰: '水开始结冰', 地始冻: '土地开始冻上', 雉入大水为蜃: '古人以为，野鸡入海变成了大蛤',
  虹藏不见: '再也看不到彩虹了', 天气上升地气下降: '天地之气不再相交', 闭塞而成冬: '万物闭藏，真正入冬了',
  鹖鴠不鸣: '寒号鸟也不叫了', 虎始交: '老虎开始求偶', 荔挺出: '马兰草冒出了新芽',
  蚯蚓结: '蚯蚓在土里缩成一团', 麋角解: '麋鹿的角脱落了', 水泉动: '地下的泉水开始流动',
  雁北乡: '大雁开始往北飞', 鹊始巢: '喜鹊开始筑巢', 雉始雊: '野鸡开始鸣叫求偶',
  鸡始乳: '母鸡开始孵小鸡', 征鸟厉疾: '鹰隼飞得又高又急', 水泽腹坚: '湖面的冰一直冻到中心',
}

/** 写作小题：偶尔出现，帮人起笔 */
const PROMPTS = [
  '此刻窗外是什么？', '今天有没有一个瞬间，想让它停一下？', '如果今天是一首诗，题目是什么？', '给今天打个分，再写一句为什么。',
  '此时此刻，能听见什么声音？', '今天最好吃的一口是什么？', '今天和谁说话最多？', '明年的今天，你希望自己在做什么？',
]

const CN_NUM = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十']
export const cnNum = (n: number) => (n >= 0 && n <= 10 ? CN_NUM[n] : String(n))

/** 现在算哪个时段。早于“一天开始”的时刻还算前一天的深夜 */
export function slotOf(hour: number, cutoffHour = 4): Slot {
  if (hour < cutoffHour || hour >= 23 || hour < 5) return 'late'
  if (hour < 9) return 'dawn'
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  if (hour < 19) return 'dusk'
  return 'night'
}

export function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** 可复现的伪随机数（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const URGE = /写|记|笔/

function usable(lines: Line[], slot: Slot): string[] {
  const nightly = slot === 'night' || slot === 'late'
  return lines.flatMap((l) => {
    if (typeof l === 'string') return [l]
    if (l.when === 'night') return nightly ? [l.t] : []
    if (l.when === 'dusk') return slot === 'dusk' ? [l.t] : []
    return nightly ? [] : [l.t]
  })
}

export interface HintContext {
  /** 日记日期（已按“一天从几点开始”换算） */
  date: string
  /** 现在（或通知发出的时刻） */
  now: Date
  cutoffHour?: number
  /** 决定这次挑哪一句；同一个 seed 结果不变。不传就按日期和时段 */
  seed?: string
  /** 以下只在首页：今天写过没有、连续几天（含今天）、距离上一篇几天 */
  wrote?: boolean
  streak?: number
  gapDays?: number
  /** 从你的日记里算出的句子（diaryFacts.ts），首页才传 */
  personal?: string[]
  /** 写完今天以后才说的话（第 N 篇、写了几段、满几万字） */
  afterWrite?: string[]
  /** 通知里用：不说跟日记状态有关的话 */
  forNotice?: boolean
}

export interface Hint {
  text: string
  /** 这句自己点明了今天是什么日子（节日、节气、交节）：通知里不用再加“今天寒露。”的前缀 */
  namesDay: boolean
  /** 来自哪一类（测试和调试用） */
  kind: string
}

/** 节气交节前后的话；没有就返回空 */
export function countdown(now: Date): string[] {
  const j = nextJieqi(now)
  const ms = j.at.getTime() - now.getTime()
  if (ms <= 0) return []
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOf(j.at) - startOf(now)) / 86400000)
  if (days === 0) {
    if (ms <= 2 * 3600_000) return [`再过一个时辰，就${j.name}了。`]
    return [`今天${SHICHEN[shichenOf(j.at.getHours())].zhi}时交${j.name}。`]
  }
  if (days === 1) return [`明天${j.name}。`]
  if (days <= 3) return [`再过${cnNum(days)}天就${j.name}了。`]
  return []
}

/** 碰上特殊日子或时刻的彩蛋 */
function eggs(c: HintContext, fest: string | undefined): string[] {
  const out: string[] = []
  const h = c.now.getHours()
  const m = c.now.getMinutes()
  if ((h === 23 && m >= 45) || (h === 0 && m <= 15)) out.push('一天走到了尽头，也是开头。')
  const l = lunarDay(c.date)
  if (l.month.startsWith('闰')) out.push(`今年有${l.month}，多出来的日子，也记一记。`)
  if (lunarDay(addDays(c.date, 1)).day === '初一') out.push('今天是这个月的晦日，月亮藏起来了。')
  const md = c.date.slice(5)
  if (md === '02-29') out.push('四年才有一次的日子，记一笔吧。')
  const wd = parseYmd(c.date).getDay()
  if (fest && (wd === 0 || wd === 6)) out.push('节日遇上周末，难得。')
  const ymd = c.date.replace(/-/g, '')
  if (ymd === [...ymd].reverse().join('')) out.push('今天的日期，正着读反着读都一样。')
  if (md.slice(0, 2) === md.slice(3)) out.push('今天的日期很整齐。')
  return out
}

export function pickHint(c: HintContext): Hint {
  const hour = c.now.getHours()
  const slot = slotOf(hour, c.cutoffHour)
  const r = rng(hash(c.seed ?? `${c.date}|${slot}`))
  const wrote = !c.forNotice && !!c.wrote
  /** 写过以后去掉催人写的句子 */
  const ok = (lines: string[]) => (wrote ? lines.filter((t) => !URGE.test(t)) : lines)
  const pick = (lines: string[]) => lines[Math.floor(r() * lines.length)]
  const l = lunarDay(c.date)
  const md = c.date.slice(5)

  // 1. 写过之后的话
  if (wrote) {
    const m = MILESTONES[c.streak ?? 0]
    if (m) return { text: m, namesDay: false, kind: 'milestone' }
    if (c.afterWrite?.length && r() < 0.5) return { text: pick(c.afterWrite), namesDay: false, kind: 'afterWrite' }
  }

  // 2. 彩蛋
  const fest = md === '01-01' ? '元旦' : md === '05-01' ? '劳动节' : md === '10-01' ? '国庆' : l.festival
  const egg = ok(eggs(c, fest))
  if (egg.length && r() < 0.3) return { text: pick(egg), namesDay: false, kind: 'egg' }
  const prompts = ok(PROMPTS)
  if (r() < 0.03 && prompts.length) return { text: pick(prompts), namesDay: false, kind: 'prompt' }

  // 节令层：七十二候、时辰、交节
  const p = pentad(c.date)
  const gloss = PENTAD_GLOSS[p.text]
  // 七十二候一候有 5 天，权重给低一些，免得这几天总看到同一句
  const seasonal: Cat[] = [
    { w: 0.25, lines: gloss ? [`${p.text}。${gloss}。`] : [] },
    { w: 0.45, lines: ok(SHICHEN[shichenOf(hour)].lines) },
    { w: 0.3, lines: countdown(c.now) },
  ]
  /** 先按权重选一类，再在这一类里等概率挑一句 */
  const fromCats = (cats: Cat[]) => {
    const live = cats.filter((k) => k.lines.length)
    let x = r() * live.reduce((t, k) => t + k.w, 0)
    const k = live.find((y) => (x -= y.w) < 0) ?? live[live.length - 1]
    return pick(k.lines)
  }
  const hasLines = (cats: Cat[]) => cats.some((k) => k.lines.length)

  // 3. 特殊日子
  const special: [Line[] | undefined, boolean, string][] = [
    [fest ? FESTIVALS[fest] : undefined, true, 'festival'],
    [l.jieqi ? JIEQI[l.jieqi] : undefined, true, 'jieqi'],
    [LUNAR_DAYS[l.day], false, 'lunar'],
    [md === '12-31' ? CAL.yearEnd : addDays(c.date, 1).endsWith('-01') ? CAL.monthEnd : md.endsWith('-01') ? CAL.monthStart : undefined, false, 'calendar'],
  ]
  const hit = special.find(([lines]) => lines && ok(usable(lines, slot)).length)
  if (hit) {
    if (r() < 0.6 || !hasLines(seasonal)) return { text: pick(ok(usable(hit[0]!, slot))), namesDay: hit[1], kind: hit[2] }
    const t = fromCats(seasonal)
    return { text: t, namesDay: /^今天.时交|^再过|^明天/.test(t), kind: 'seasonal' }
  }

  // 4. 平时：分层抽取。节令 35%，你的日记 30%，写过以后“写过了”那组 25%，剩下的给时段、季节、通用、周末假期
  const soft: string[] = []
  if (!c.forNotice && (c.gapDays ?? 0) >= 7) soft.push(...SOFT.gap)
  const wd = parseYmd(c.date).getDay()
  if (l.holiday) soft.push(...(l.holiday.off ? SOFT.holiday : SOFT.workday))
  else if (wd === 0 || wd === 6) soft.push(...SOFT.weekend)
  else if (wd === 1) soft.push(...SOFT.monday)
  else if (wd === 5) soft.push(...SOFT.friday)
  const rest: Cat[] = [
    { w: 1, lines: ok(usable(SLOTS[slot], slot)) },
    { w: 0.7, lines: ok(usable(SEASONS[seasonOf(l.term)], slot)) },
    { w: 1.6, lines: ok(usable(GENERAL, slot)) },
    { w: 0.7, lines: ok(soft) },
  ]
  const layers: { w: number; kind: string; cats: Cat[] }[] = [
    { w: 0.35, kind: 'seasonal', cats: seasonal },
    { w: 0.3, kind: 'personal', cats: [{ w: 1, lines: c.forNotice ? [] : c.personal ?? [] }] },
    { w: 0.25, kind: 'wrote', cats: [{ w: 1, lines: wrote ? usable(WROTE, slot) : [] }] },
  ].filter((y) => hasLines(y.cats))
  layers.push({ w: Math.max(0.1, 1 - layers.reduce((t, y) => t + y.w, 0)), kind: 'rest', cats: rest })
  let x = r()
  const layer = layers.find((y) => (x -= y.w) < 0) ?? layers[layers.length - 1]
  const text = fromCats(layer.cats)
  return { text, namesDay: layer.kind === 'seasonal' && /^今天.时交|^再过|^明天/.test(text), kind: layer.kind }
}

/** 测试用：全部固定句子（不含七十二候、交节和从日记里算出的句子） */
export function allLines(): string[] {
  const all: Line[] = [
    ...GENERAL, ...Object.values(SLOTS).flat(), ...Object.values(SEASONS).flat(), ...Object.values(FESTIVALS).flat(),
    ...Object.values(JIEQI).flat(), ...Object.values(LUNAR_DAYS).flat(), ...Object.values(CAL).flat(), ...Object.values(SOFT).flat(),
    ...WROTE, ...Object.values(MILESTONES), ...SHICHEN.flatMap((s) => s.lines), ...PROMPTS,
  ]
  return all.map((y) => (typeof y === 'string' ? y : y.t))
}

