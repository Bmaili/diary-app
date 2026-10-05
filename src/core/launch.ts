/** 解析桌面快捷方式打开应用时带的链接（见 launchService.ts） */
export type LaunchTarget = 'write-today'

export function launchTarget(url: string | null | undefined): LaunchTarget | null {
  if (!url) return null
  const m = /^app\.diary\.local:\/\/([^?#]*)/.exec(url)
  if (!m) return null
  const path = m[1].replace(/\/+$/, '')
  return path === 'write/today' ? 'write-today' : null
}
