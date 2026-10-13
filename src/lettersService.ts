/**
 * 写给未来的信的应用层（规格 5.13）：读写信件、到期提醒、首页的“信到了”。
 * 信件格式见 core/letters.ts。
 */
import { reactive } from 'vue'
import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { diaryChanged, enqueue, onDiaryChanged, onStarted, repo, store, today } from './app'
import {
  LETTER_BASE_ID, LETTER_IMG, LETTER_MAX, LETTERS, letterBody, letterImages, letterPath, letterState, letterText, listLetters,
  newLetterId, parseLetter, planLetterReminders, serializeLetter, type Letter,
} from './core/letters'
import { toBase64 } from './core/bytes'
import { extOf, pathUrl, type Compressed } from './imageService'
import { trashLetter } from './core/trash'
import { isoLocal } from './core/time'
import { syncAfterEdit } from './syncService'

export const letters = reactive({
  list: [] as Letter[],
  broken: [] as string[],
  loaded: false,
  /** 首页“信到了”这次打开 app 已经点过“晚点再看” */
  snoozed: false,
})

export async function reloadLetters(): Promise<void> {
  const r = await listLetters(store)
  letters.list = r.letters
  letters.broken = r.broken
  letters.loaded = true
}

export const arrived = () => letters.list.filter((l) => letterState(l, today()) === 'arrived')

async function write(l: Letter) {
  await enqueue(() => repo.writeAtomic(letterPath(l.id), serializeLetter(l)))
}

async function changed() {
  await reloadLetters()
  void scheduleLetterReminders()
  diaryChanged()
  syncAfterEdit()
}

/** 封存一封新信，返回它的编号 */
export async function sealLetter(o: { body: string; openOn: string; remind: boolean; images?: string[] }, now = new Date()): Promise<string> {
  const id = await newLetterId(store, today())
  await write({ id, meta: { written: isoLocal(now), open_on: o.openOn, ...(o.remind ? { remind: true } : {}) }, body: letterBody(o.body, o.images ?? []), extra: [] })
  if (o.remind) await requestLetterPermission()
  await changed()
  return id
}

async function readLetter(id: string): Promise<Letter> {
  const raw = await store.readText(letterPath(id))
  if (raw == null) throw new Error('这封信不见了')
  return parseLetter(raw, id)
}

/** 拆开：记下拆信的时间（只记第一次） */
export async function openLetter(id: string): Promise<Letter> {
  const l = await readLetter(id)
  if (letterState(l, today()) === 'sealed') throw new Error('还没到拆信的日子')
  if (!l.meta.opened) {
    l.meta.opened = isoLocal(new Date())
    await write(l)
    await changed()
  }
  return l
}

/** 改拆信日期（只有封着的信可以改） */
export async function changeOpenDate(id: string, date: string): Promise<void> {
  const l = await readLetter(id)
  if (l.meta.opened) throw new Error('已经拆过了')
  l.meta.open_on = date
  await write(l)
  await changed()
}

/** 撤回（封着的）或删除（拆过的）：都移到最近删除，30 天内可以恢复。封着的信在最近删除里不露内容 */
export async function trashLetterById(id: string): Promise<void> {
  const l = await readLetter(id)
  const preview = letterState(l, today()) === 'opened' ? letterText(l.body) || '（只有照片的信）' : '（一封撤回的信，没拆过）'
  await enqueue(() => trashLetter(store, id, preview, new Date(), letterImages(l.body)))
  await changed()
}

// ---------- 随信附上的照片（2026-10-13 加入） ----------

/** 写信时存一张照片，返回信里用的相对路径（img/…）。草稿阶段就写进 letters/img/，封存时随信带走 */
export async function saveLetterImage(img: Compressed): Promise<string> {
  const name = `${today()}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.${extOf(img.mime)}`
  await store.mkdirp(LETTER_IMG)
  await store.writeBase64(`${LETTER_IMG}/${name}`, toBase64(img.bytes))
  return `img/${name}`
}

/** 草稿里去掉一张照片：它只属于这份草稿，直接删掉文件 */
export async function removeDraftImage(rel: string): Promise<void> {
  if (!/^img\/[^/]+$/.test(rel)) return
  await store.remove(`${LETTERS}/${rel}`).catch(() => {})
}

/** 信里照片（img/…）的显示地址 */
export function letterImageUrl(rel: string): Promise<string> {
  return pathUrl(`${LETTERS}/${rel}`)
}

/** 读信时把正文里的照片换成能显示的地址 */
export async function resolveLetterImages(html: string): Promise<string> {
  const srcs = new Set([...html.matchAll(/<img[^>]+src="(img\/[^"]+)"/g)].map((m) => m[1]))
  const urls = new Map<string, string>()
  for (const s of srcs) {
    const u = await letterImageUrl(decodeURI(s)).catch(() => '')
    if (u) urls.set(s, u)
  }
  return html.replace(/(<img[^>]+src=")(img\/[^"]+)(")/g, (m, a: string, src: string, b: string) =>
    urls.has(src) ? `${a}${urls.get(src)}${b} data-src="${src}"` : m)
}

// ---------- 到期提醒：本地通知，到拆信那天早上 9 点 ----------

const CHANNEL = 'letter'
const supported = Capacitor.isNativePlatform()

export async function requestLetterPermission(): Promise<boolean> {
  if (!supported) return false
  try {
    return (await LocalNotifications.requestPermissions()).display === 'granted'
  } catch {
    return false
  }
}

let running: Promise<void> = Promise.resolve()
export function scheduleLetterReminders(): Promise<void> {
  running = running.then(doSchedule, doSchedule).catch(() => {})
  return running
}

async function doSchedule() {
  if (!supported) return
  const pending = await LocalNotifications.getPending()
  const ours = pending.notifications.filter((n) => n.id >= LETTER_BASE_ID && n.id < LETTER_BASE_ID + LETTER_MAX)
  if (ours.length) await LocalNotifications.cancel({ notifications: ours.map((n) => ({ id: n.id })) })
  if ((await LocalNotifications.checkPermissions()).display !== 'granted') return
  const plan = planLetterReminders(letters.list, new Date())
  if (!plan.length) return
  await LocalNotifications.schedule({
    notifications: plan.map((p) => ({
      id: p.id,
      title: '浮生记',
      // 锁屏上也看得到：只说有信，不露内容
      body: '有一封写给今天的信到了。',
      channelId: CHANNEL,
      schedule: { at: p.at, allowWhileIdle: true },
      isExactNotification: false,
      autoCancel: true,
      extra: { kind: 'letter', letter: p.letter },
    })),
  })
}

export function initLetters() {
  if (supported) {
    void LocalNotifications.createChannel({ id: CHANNEL, name: '寄往来日', description: '写给未来的信到了', importance: 3 }).catch(() => {})
  }
  onStarted(() => {
    void reloadLetters().then(() => scheduleLetterReminders())
  })
  // 从云端恢复、导入之后信可能变了
  onDiaryChanged(() => void reloadLetters())
}
