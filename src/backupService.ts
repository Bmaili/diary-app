/**
 * 导出为 zip（设置页和首页的备份提醒共用），并记下导出时间，备份提醒据此判断 30 天内有没有导出过。
 */
import { reactive } from 'vue'
import { index, repo } from './app'
import { exportDiaryZip, zipFileName } from './core/exportZip'
import { isoLocal } from './core/time'
import { openExport } from './platform/exportShare'
import { expectExternal } from './lockService'
import { prefs } from './prefs'

export const exporting = reactive({ busy: false, done: 0, total: 0 })

/** 打包整个日记文件夹并调起系统分享，返回一句结果说明 */
export async function exportZip(): Promise<string> {
  if (exporting.busy) return ''
  exporting.busy = true
  exporting.done = exporting.total = 0
  try {
    const target = await openExport(zipFileName())
    const r = await exportDiaryZip(repo, target.sink, (done, total) => {
      exporting.done = done
      exporting.total = total
    })
    const done = expectExternal()
    try {
      await target.finish()
    } finally {
      done()
    }
    prefs.backup.lastExport = isoLocal(new Date())
    const size = r.bytes >= 1 << 20 ? `${(r.bytes / (1 << 20)).toFixed(1)} MB` : `${(r.bytes / 1024).toFixed(0)} KB`
    return `已打包 ${index.size} 篇日记、共 ${r.files} 个文件（${size}）`
  } finally {
    exporting.busy = false
  }
}
