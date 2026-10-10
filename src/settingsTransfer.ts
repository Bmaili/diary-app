/**
 * 设置的导入导出（2026-10-10 加入）：从 prefs 和密钥存储里收集选中的类别，导入时整类覆盖。
 * 文件格式和加解密见 core/settingsBundle.ts。
 *
 * 不导出：应用锁的 PIN 和指纹（跟着这台手机走）、“已同意把日记发给某个 AI 服务”的记录（换手机后再问一次）。
 * 导入同步设置时，换了 Bucket / 仓库的后端先保持关闭：要用户自己去打开开关，走“云端已有日记，先恢复吗”的流程，
 * 免得新手机上刚写的几篇覆盖掉云端的同名日记。
 */
import { enqueue, setCutoffHour, settings } from './app'
import { merge, prefs, savePrefsNow } from './prefs'
import { getSecret, setSecret } from './platform/secrets'
import { fromBase64, toBase64 } from './core/bytes'
import { PARTS, type BundlePart, type PartId, type SettingsBundle } from './core/settingsBundle'
import { BACKENDS, loadKeys, refreshPending, resetManifest, saveKeys, type BackendId } from './syncService'
import { holidaySourceChanged } from './holidayService'
import { requestReminderPermission, reminderSupported } from './reminderService'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const SYNC_SECRETS = ['oss.secret', 'github.token']
const PLACE_SECRETS = ['amap.key', 'qweather.key']
const MISC_KEYS = ['reminder', 'daily', 'calendar', 'ui', 'update'] as const

/** 每类设置现在是什么情况（导出页显示） */
export function partStatus(id: PartId): string {
  switch (id) {
    case 'ai':
      return prefs.ai.profiles.length ? `已添加 ${prefs.ai.profiles.length} 个服务` : '还没有添加服务'
    case 'sync': {
      const names = BACKENDS.filter((b) => configured(b.id, prefs.sync)).map((b) => b.label)
      return names.length ? `已配置 ${names.join('、')}` : '还没有配置'
    }
    case 'place':
      return prefs.place.autoLocate ? '自动定位已开启' : '自动定位已关闭'
    case 'misc':
      return prefs.reminder.enabled ? `每天 ${prefs.reminder.time} 提醒` : '提醒未开启'
  }
}

function configured(id: BackendId, sync: unknown): boolean {
  const s = (sync as Record<string, Record<string, string>>)?.[id]
  if (!s) return false
  return id === 'oss' ? !!(s.endpoint && s.bucket) : !!(s.owner && s.repo)
}

/** 后端指向哪里：变了就要重新走“首次启用”的流程 */
function targetOf(id: BackendId, sync: unknown): string {
  const s = ((sync as Record<string, Record<string, string>>)?.[id] ?? {}) as Record<string, string>
  return id === 'oss'
    ? [s.endpoint, s.bucket, s.prefix].join('|')
    : [s.apiBase, s.owner, s.repo, s.branch, s.prefix].join('|')
}

async function secretsOf(names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const n of names) {
    const v = await getSecret(n)
    if (v) out[n] = v
  }
  return out
}

async function collect(id: PartId): Promise<BundlePart> {
  switch (id) {
    case 'ai': {
      const { consented: _skip, ...rest } = clone(prefs.ai)
      void _skip
      return { prefs: rest, secrets: await secretsOf(prefs.ai.profiles.map((p) => `llm.${p.id}`)) }
    }
    case 'sync': {
      const k = await loadKeys()
      return {
        prefs: clone(prefs.sync),
        secrets: await secretsOf(SYNC_SECRETS),
        extra: k ? { keys: { identity: k.identity, recipient: k.recipient, wrapped: toBase64(k.wrapped) } } : undefined,
      }
    }
    case 'place':
      return { prefs: clone(prefs.place), secrets: await secretsOf(PLACE_SECRETS) }
    case 'misc':
      return {
        prefs: clone(Object.fromEntries(MISC_KEYS.map((k) => [k, prefs[k]]))),
        secrets: {},
        extra: { cutoffHour: settings.cutoffHour },
      }
  }
}

export async function buildBundle(ids: PartId[]): Promise<SettingsBundle> {
  const parts: SettingsBundle['parts'] = {}
  for (const { id } of PARTS) if (ids.includes(id)) parts[id] = await collect(id)
  return { app: 'diary-app', kind: 'settings', version: 1, exportedAt: new Date().toISOString(), appVersion: __APP_VERSION__, parts }
}

/** 文件里某一类的内容摘要（导入页显示） */
export function bundlePartSummary(id: PartId, p: BundlePart): string {
  const pr = p.prefs as Record<string, unknown>
  switch (id) {
    case 'ai': {
      const n = Array.isArray(pr.profiles) ? pr.profiles.length : 0
      return n ? `${n} 个服务` : '没有服务'
    }
    case 'sync': {
      const names = BACKENDS.filter((b) => configured(b.id, pr)).map((b) => b.label)
      const keys = (p.extra as { keys?: unknown } | undefined)?.keys ? '，含云端加密的密钥' : ''
      return (names.length ? names.join('、') : '没有配置后端') + keys
    }
    case 'place':
      return Object.keys(p.secrets).length ? '含高德 / 和风天气的 key' : '不含 key'
    case 'misc': {
      const r = pr.reminder as { enabled?: boolean; time?: string } | undefined
      return r?.enabled ? `每天 ${r.time} 提醒` : '提醒未开启'
    }
  }
}

export interface ImportResult {
  /** 导入后还要用户去做的事 */
  todo: string[]
}

/** 把选中的类别整类覆盖到本机 */
export async function applyBundle(b: SettingsBundle, ids: PartId[]): Promise<ImportResult> {
  const todo: string[] = []
  for (const { id } of PARTS) {
    const p = b.parts[id]
    if (!p || !ids.includes(id)) continue
    if (id === 'ai') await applyAi(p)
    else if (id === 'sync') todo.push(...(await applySync(p)))
    else if (id === 'place') await applyPlace(p)
    else todo.push(...(await applyMisc(p)))
  }
  await savePrefsNow()
  return { todo }
}

async function applyAi(p: BundlePart) {
  const incoming = p.prefs as Record<string, unknown>
  if (Array.isArray(incoming.profiles)) {
    const keep = new Set((incoming.profiles as { id?: unknown }[]).map((x) => String(x?.id ?? '')))
    // 本机有、文件里没有的服务：连同 key 一起删掉
    for (const old of prefs.ai.profiles) if (!keep.has(old.id)) await setSecret(`llm.${old.id}`, '')
  }
  const { consented: _skip, ...rest } = incoming
  void _skip
  merge(prefs.ai as unknown as Record<string, unknown>, rest)
  for (const prof of prefs.ai.profiles) await setSecret(`llm.${prof.id}`, p.secrets[`llm.${prof.id}`] ?? '')
}

async function applySync(p: BundlePart): Promise<string[]> {
  const todo: string[] = []
  const before = clone(prefs.sync)
  merge(prefs.sync as unknown as Record<string, unknown>, p.prefs)
  for (const n of SYNC_SECRETS) await setSecret(n, p.secrets[n] ?? '')
  const keys = (p.extra as { keys?: { identity?: unknown; recipient?: unknown; wrapped?: unknown } } | undefined)?.keys
  if (keys && typeof keys.identity === 'string' && typeof keys.recipient === 'string' && typeof keys.wrapped === 'string') {
    await saveKeys({ identity: keys.identity, recipient: keys.recipient, wrapped: fromBase64(keys.wrapped) })
  }
  for (const { id, label } of BACKENDS) {
    const wanted = !!(p.prefs as Record<string, { enabled?: boolean }>)[id]?.enabled
    if (targetOf(id, before) === targetOf(id, prefs.sync)) {
      // 还是同一个 Bucket / 仓库：保持本机原来的开关
      prefs.sync[id].enabled = before[id].enabled
    } else {
      prefs.sync[id].enabled = false
      await enqueue(() => resetManifest(id))
    }
    if (wanted && !prefs.sync[id].enabled) todo.push(`到“同步与备份”里打开 ${label} 的开关（云端已有日记时会先问你要不要恢复）`)
  }
  await refreshPending()
  return todo
}

async function applyPlace(p: BundlePart) {
  merge(prefs.place as unknown as Record<string, unknown>, p.prefs)
  for (const n of PLACE_SECRETS) await setSecret(n, p.secrets[n] ?? '')
}

async function applyMisc(p: BundlePart): Promise<string[]> {
  const todo: string[] = []
  // 只认这几组，文件里别的键（比如应用锁）一律不管
  const src = p.prefs as Record<string, unknown>
  const picked: Record<string, unknown> = {}
  for (const k of MISC_KEYS) if (src[k] && typeof src[k] === 'object') picked[k] = src[k]
  merge(prefs as unknown as Record<string, unknown>, picked)
  const h = Number((p.extra as { cutoffHour?: unknown } | undefined)?.cutoffHour)
  if (Number.isInteger(h) && h >= 0 && h <= 6) await setCutoffHour(h)
  holidaySourceChanged()
  if (prefs.reminder.enabled && reminderSupported && !(await requestReminderPermission())) {
    prefs.reminder.enabled = false
    todo.push('写日记提醒需要通知权限，没有获准，已先关闭')
  }
  return todo
}
