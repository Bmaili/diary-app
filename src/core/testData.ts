/**
 * 测试日记生成器（开发者选项里用）。生成的文件带有未知字段 `test_data: true`，
 * 既能验证未知字段被保留，也能一键清除，不会和真实日记混在一起。
 */
import { Pair, Scalar } from 'yaml'
import type { DiaryRepo } from './repo'
import { addDays, isoLocal, parseYmd } from './time'
import type { EntryDoc } from './entryFile'
import { serializeEntry } from './entryFile'
import { entryPath } from './repo'

const PEOPLE = ['小王', '阿杰', '妈妈', '老陈', '林老师', '小雨']
const PLACES = ['楼下面馆', '星巴克', '公司', '江边公园', '海底捞', '图书馆', '健身房', '菜市场']
const TAGS = ['工作', '运动', '读书', '聚餐', '旅行', '散步', '电影', '家务']
const WEATHER = ['晴', '多云', '阴', '小雨', '大雨', '雾']
const LINES = [
  '早上醒得很早，泡了一壶茶慢慢喝完。',
  '下午开了两个会，讨论到最后也没定下来。',
  '晚上和{p}去{l}吃饭，聊了很多以前的事。',
  '去{l}待了一下午，看完了半本书。',
  '跑步五公里，膝盖有点酸。',
  '今天什么都不想做，躺着听了一整天的雨。',
  '{p}打电话来，说下个月要回来。',
  '路过{l}，买了一袋橘子。',
  '工作上终于把那个拖了很久的问题解决了。',
  '看了一部老电影，结尾比记忆里更好。',
]

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export interface GenOptions {
  count: number
  /** 最后一篇的日期，向前逐日生成 */
  endDate: string
  seed?: number
  /** 跳过已存在的日期，避免覆盖真实日记 */
  skipExisting?: boolean
}

export function makeTestEntry(date: string, rand: () => number): EntryDoc {
  const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)]
  const p = pick(PEOPLE)
  const l = pick(PLACES)
  const n = 1 + Math.floor(rand() * 4)
  const body = Array.from({ length: n }, () => pick(LINES).replace('{p}', p).replace('{l}', l)).join('')
  const usesPlace = body.includes(l)
  const usesPerson = body.includes(p)
  const t = parseYmd(date)
  t.setHours(21, Math.floor(rand() * 60), 0)
  const stamp = isoLocal(t)
  return {
    meta: {
      date,
      created: stamp,
      updated: stamp,
      weather: { text: pick(WEATHER), temp_c: 5 + Math.floor(rand() * 28) },
      mood: 1 + Math.floor(rand() * 5),
      tags: rand() < 0.6 ? [pick(TAGS)] : undefined,
      people: usesPerson ? [p] : undefined,
      places: usesPlace ? [l] : undefined,
    },
    body,
    extra: [new Pair(new Scalar('test_data'), new Scalar(true))],
  }
}

export async function generateTestEntries(repo: DiaryRepo, o: GenOptions): Promise<number> {
  const rand = rng(o.seed ?? 42)
  let made = 0
  for (let i = 0; i < o.count; i++) {
    const date = addDays(o.endDate, -i)
    if (o.skipExisting !== false && (await repo.store.stat(entryPath(date)))) continue
    // 生成器直接写文件，不经过 saveEntry，以保留虚构的 created/updated
    await repo.store.mkdirp(entryPath(date).slice(0, entryPath(date).lastIndexOf('/')))
    await repo.store.writeText(entryPath(date), serializeEntry(makeTestEntry(date, rand)))
    made++
  }
  return made
}
