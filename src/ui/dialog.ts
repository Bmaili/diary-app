/**
 * app 自己的提示框（2026-10-13 起替换 window.confirm / alert / prompt）。
 * 系统弹窗是 WebView 自带的白底黑字，样式改不了；按钮也只能写“确定 / 取消”，二选一时很容易点错。
 *
 * - 一次只显示一个，后来的排队。
 * - 安卓返回键、点遮罩、Esc 都按 dismiss 处理：调用方要把 dismiss 设成更安全的那个选项（不删除、不覆盖）。
 * - 界面在 components/AppDialog.vue，挂在 App.vue。
 */
import { reactive } from 'vue'

export type ButtonKind = 'primary' | 'danger' | 'ghost'

export interface DialogButton<T extends string = string> {
  label: string
  value: T
  kind?: ButtonKind
}

export interface DialogRequest {
  title: string
  message?: string
  buttons: DialogButton[]
  /** 返回键、点遮罩时的结果 */
  dismiss: string
  /** 按钮竖排（选项文字较长的二选一） */
  stacked?: boolean
  /** 带一个输入框（代替 prompt） */
  input?: { value: string; label: string }
}

interface Pending {
  req: DialogRequest
  resolve: (r: { value: string; input: string }) => void
}

export const dialog = reactive({
  current: null as DialogRequest | null,
  input: '',
})

const queue: Pending[] = []
let active: Pending | null = null

function next() {
  active = queue.shift() ?? null
  dialog.current = active?.req ?? null
  dialog.input = active?.req.input?.value ?? ''
}

export function showDialog(req: DialogRequest): Promise<{ value: string; input: string }> {
  return new Promise((resolve) => {
    queue.push({ req, resolve })
    if (!active) next()
  })
}

/** 界面上点了按钮（或返回键、遮罩：value 为 null 时取 dismiss） */
export function answer(value: string | null) {
  const a = active
  if (!a) return
  a.resolve({ value: value ?? a.req.dismiss, input: dialog.input })
  next()
}

/** 确定 / 取消。危险操作（删除等）把 danger 设为 true，确定按钮用朱红 */
export async function ask(o: { title: string; message?: string; ok?: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  const r = await showDialog({
    title: o.title,
    message: o.message,
    buttons: [
      { label: o.cancel ?? '取消', value: 'no', kind: 'ghost' },
      { label: o.ok ?? '确定', value: 'yes', kind: o.danger ? 'danger' : 'primary' },
    ],
    dismiss: 'no',
  })
  return r.value === 'yes'
}

/** 几个明确的选项，按钮竖排 */
export async function choose<T extends string>(o: {
  title: string
  message?: string
  options: DialogButton<T>[]
  dismiss: T
}): Promise<T> {
  const r = await showDialog({ title: o.title, message: o.message, buttons: o.options, dismiss: o.dismiss, stacked: true })
  return r.value as T
}

/** 只是告诉一声 */
export async function tell(o: { title: string; message?: string; ok?: string }): Promise<void> {
  await showDialog({ title: o.title, message: o.message, buttons: [{ label: o.ok ?? '知道了', value: 'ok', kind: 'primary' }], dismiss: 'ok' })
}

/** 输入一行字；取消时返回 null */
export async function promptText(o: { title: string; message?: string; value?: string; label?: string; ok?: string }): Promise<string | null> {
  const r = await showDialog({
    title: o.title,
    message: o.message,
    input: { value: o.value ?? '', label: o.label ?? o.title },
    buttons: [
      { label: '取消', value: 'no', kind: 'ghost' },
      { label: o.ok ?? '确定', value: 'yes', kind: 'primary' },
    ],
    dismiss: 'no',
  })
  return r.value === 'yes' ? r.input : null
}
