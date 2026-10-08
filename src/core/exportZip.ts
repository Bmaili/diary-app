import type { DiaryRepo } from './repo'
import { fromBase64 } from './bytes'
import { ZipWriter, type ByteSink } from './zipWriter'

const TEXT_EXT = /\.(md|json|txt|csv|ya?ml)$/i

/**
 * 把整个 diary/ 打包成 zip（规格 5.7“导出为 zip”），压缩包内顶层目录为 diary/。
 * 一个文件一个文件地读、写进 sink（见 zipWriter.ts）：图片再多，内存里也只有当前这一个文件。
 */
export async function exportDiaryZip(
  repo: DiaryRepo,
  sink: ByteSink,
  onProgress?: (done: number, total: number) => void,
): Promise<{ files: number; bytes: number }> {
  const zip = new ZipWriter(sink)
  const enc = new TextEncoder()
  const paths = await repo.listAllFiles()
  let done = 0
  for (const path of paths) {
    if (TEXT_EXT.test(path)) {
      const t = await repo.store.readText(path)
      if (t != null) await zip.add(path, enc.encode(t), { compress: true })
    } else {
      const b = await repo.store.readBase64(path)
      if (b != null) await zip.add(path, fromBase64(b))
    }
    done++
    if (onProgress && (done % 50 === 0 || done === paths.length)) onProgress(done, paths.length)
  }
  return zip.finish()
}

export function zipFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `diary-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.zip`
}
