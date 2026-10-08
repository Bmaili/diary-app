import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import type { ByteSink } from '../core/zipWriter'

function toBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}

/** 攒够这么多字节再写一次盘：块太小插件调用太多，太大又占内存 */
const FLUSH_AT = 1 << 20

export interface ExportTarget {
  sink: ByteSink
  /** 写完后：真机调起系统分享，浏览器触发下载 */
  finish(): Promise<void>
}

/**
 * 导出文件（2026-10-08 起边写边存）。
 * 真机：写到 app 的缓存目录，每攒约 1 MB 追加写一次，写完后调起系统分享（可存到文件管理、网盘或发给自己）。
 * 以前是在内存里拼出整个 zip、再整体转成 base64 交给原生端，图片多了会因内存不足闪退。
 * 浏览器：收集成 Blob 后下载。
 */
export async function openExport(name: string, mime = 'application/zip'): Promise<ExportTarget> {
  if (Capacitor.isNativePlatform()) {
    // 上次导出的包已经分享出去了，清掉，免得缓存目录越积越大
    try {
      const old = await Filesystem.readdir({ path: '', directory: Directory.Cache })
      for (const f of old.files) {
        if (/^diary-.*\.zip$/.test(f.name)) await Filesystem.deleteFile({ path: f.name, directory: Directory.Cache }).catch(() => {})
      }
    } catch { /* 缓存目录读不了就算了 */ }
    await Filesystem.writeFile({ path: name, data: '', directory: Directory.Cache })
    let buf: Uint8Array[] = []
    let size = 0
    const flush = async () => {
      if (!size) return
      const all = new Uint8Array(size)
      let o = 0
      for (const c of buf) {
        all.set(c, o)
        o += c.length
      }
      buf = []
      size = 0
      await Filesystem.appendFile({ path: name, data: toBase64(all), directory: Directory.Cache })
    }
    return {
      sink: {
        async write(chunk) {
          buf.push(chunk.slice())
          size += chunk.length
          if (size >= FLUSH_AT) await flush()
        },
      },
      async finish() {
        await flush()
        const { uri } = await Filesystem.getUri({ path: name, directory: Directory.Cache })
        await Share.share({ title: name, files: [uri], dialogTitle: '保存或发送日记备份' })
      },
    }
  }
  const parts: Uint8Array[] = []
  return {
    sink: {
      async write(chunk) {
        parts.push(chunk.slice())
      },
    },
    async finish() {
      const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: mime }))
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    },
  }
}
