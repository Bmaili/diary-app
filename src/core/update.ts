/**
 * 应用内更新（2026-10-10 加入）：解析 GitHub Releases 的“最新版本”接口，和本机版本比较。
 * 纯函数，便于测试；联网、下载、安装见 updateService.ts 和原生插件 AppUpdatePlugin.java。
 */

export interface ReleaseInfo {
  /** 1.0.16 */
  version: string
  /** 更新内容（提交说明，去掉了 Releases 页面上给手动下载的人看的安装提示） */
  notes: string
  publishedAt: string
  /** Releases 网页（应用内下载失败时，去浏览器下载） */
  pageUrl: string
  apk: { name: string; url: string; size: number; sha256: string } | null
}

/** 下到一半的安装包（原生插件 partial() 返回的）：版本、大小、sha256，已经下了多少字节 */
export interface PartialDownload {
  version?: string
  sha256?: string
  size?: number
  bytes?: number
}

/**
 * 能不能接着上次下（2026-10-12 加入断点续传）：半截文件的版本、大小、sha256 都和要下的这个一致，
 * 而且还没下完，才返回已下载的字节数；否则返回 0（从头下）。
 * 例如 1.0.11 下了一半没装，1.0.12 发布了：版本不同，从头下 1.0.12。
 * 没有 sha256 时认不准是不是同一个文件，也从头下。
 */
export function resumeOffset(p: PartialDownload | null | undefined, version: string, apk: ReleaseInfo['apk']): number {
  if (!p || !apk || !apk.sha256 || !p.sha256) return 0
  if (p.version !== version || p.size !== apk.size || p.sha256.toLowerCase() !== apk.sha256.toLowerCase()) return 0
  const b = Number(p.bytes) || 0
  return b > 0 && b < apk.size ? b : 0
}

/** 两次自动检查至少隔这么久 */
export const AUTO_CHECK_MS = 24 * 3600 * 1000

/** 版本号里的数字段；不是 1.0.N 这类格式（例如本地开发版 dev）返回 null */
export function versionParts(v: string): number[] | null {
  const m = /^v?(\d+(?:\.\d+)*)$/.exec(v.trim())
  return m ? m[1].split('.').map(Number) : null
}

/**
 * latest 是否比 current 新。current 不是正式版本号（本地开发版）时，任何正式版本都算新的；
 * latest 本身格式不对时不算。
 */
export function isNewer(latest: string, current: string): boolean {
  const a = versionParts(latest)
  if (!a) return false
  const b = versionParts(current)
  if (!b) return true
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/** Releases 说明里 “---” 之后是给手动下载的人看的安装提示，应用内不显示 */
export function cleanNotes(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const cut = lines.findIndex((l) => /^\s*-{3,}\s*$/.test(l))
  return (cut >= 0 ? lines.slice(0, cut) : lines)
    .filter((l) => !/^(Claude-Session|Co-Authored-By):/i.test(l))
    .join('\n')
    .trim()
}

interface GhAsset { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown }

/** 解析 GET /repos/{owner}/{repo}/releases/latest 的返回；格式不对抛错 */
export function parseRelease(json: unknown): ReleaseInfo {
  const r = json as { tag_name?: unknown; body?: unknown; published_at?: unknown; html_url?: unknown; assets?: unknown; draft?: unknown; prerelease?: unknown }
  if (!r || typeof r.tag_name !== 'string') throw new Error('版本信息格式不对')
  const version = r.tag_name.replace(/^v/, '')
  if (!versionParts(version)) throw new Error(`看不懂的版本号：${r.tag_name}`)
  const assets = Array.isArray(r.assets) ? (r.assets as GhAsset[]) : []
  // 签过名的正式安装包；没签名的（-unsigned.apk）装不上，不要
  const a = assets.find((x) => typeof x.name === 'string' && /\.apk$/i.test(x.name) && !/unsigned/i.test(x.name))
  const digest = typeof a?.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(a.digest)?.[1]?.toLowerCase() ?? '' : ''
  return {
    version,
    notes: cleanNotes(typeof r.body === 'string' ? r.body : ''),
    publishedAt: typeof r.published_at === 'string' ? r.published_at : '',
    pageUrl: typeof r.html_url === 'string' ? r.html_url : '',
    apk: a && typeof a.browser_download_url === 'string'
      ? { name: String(a.name), url: a.browser_download_url, size: Number(a.size) || 0, sha256: digest }
      : null,
  }
}

/** 13416761 → “12.8 MB” */
export function formatSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
