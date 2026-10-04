import JSZip from 'jszip'
import type { DiaryRepo } from './repo'

const TEXT_EXT = /\.(md|json|txt|csv|ya?ml)$/i

/** 把整个 diary/ 打包成 zip（规格 5.7“导出为 zip”），压缩包内顶层目录为 diary/。 */
export async function exportDiaryZip(repo: DiaryRepo): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const path of await repo.listAllFiles()) {
    if (TEXT_EXT.test(path)) {
      const t = await repo.store.readText(path)
      if (t != null) zip.file(path, t)
    } else {
      const b = await repo.store.readBase64(path)
      if (b != null) zip.file(path, b, { base64: true })
    }
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

export function zipFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `diary-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.zip`
}
