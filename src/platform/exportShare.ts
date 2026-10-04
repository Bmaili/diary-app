import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

function toBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}

/** 真机：写到缓存目录后调起系统分享（可存到文件管理、网盘或发给自己）；浏览器：直接下载。 */
export async function shareFile(name: string, bytes: Uint8Array, mime = 'application/zip'): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const r = await Filesystem.writeFile({ path: name, data: toBase64(bytes), directory: Directory.Cache })
    await Share.share({ title: name, files: [r.uri], dialogTitle: '保存或发送日记备份' })
    return
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
