/**
 * 导入日记的应用层（规格 5.12）：读用户选的文件 → 算出导入计划给用户确认 → 写盘、刷新索引、触发同步。
 * 状态放在模块里：导入途中离开页面也不会中断，回来还能看到进度和结果。
 */
import { reactive } from 'vue'
import { diaryChanged, enqueue, reloadIndex, repo } from './app'
import { applyImport, planImport, type DupMode, type ImportFile, type ImportPlan, type ImportResult } from './core/importDiary'
import { blobAccess, readZipEntries, readZipFile } from './core/zipReader'
import { syncAfterEdit } from './syncService'

export const importState = reactive({
  /** idle 还没选；reading 读文件；ready 等确认；running 导入中；done 完成 */
  phase: 'idle' as 'idle' | 'reading' | 'ready' | 'running' | 'done',
  fileLabel: '',
  fileSize: 0,
  plan: null as ImportPlan | null,
  mode: 'keep' as DupMode,
  done: 0,
  total: 0,
  result: null as ImportResult | null,
  error: '',
})

/** 选好的文件 → 导入用的文件列表：一个 zip 就展开它，否则当作一组 .md / .txt */
async function toImportFiles(files: File[]): Promise<ImportFile[]> {
  const zips = files.filter((f) => /\.zip$/i.test(f.name) || f.type === 'application/zip')
  if (zips.length > 1) throw new Error('一次只能导入一个 zip')
  if (zips.length === 1) {
    if (files.length > 1) throw new Error('选了 zip 就不要再选别的文件了')
    const acc = blobAccess(zips[0])
    const entries = await readZipEntries(acc)
    return entries
      .filter((e) => !e.dir)
      .map((e) => ({ path: e.name, size: e.size, read: () => readZipFile(acc, e) }))
  }
  return files.map((f) => ({ path: f.name, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) }))
}

/** 上次选的文件：导入中途出错后重新算计划用 */
let current: ImportFile[] = []

export async function chooseFiles(files: File[]) {
  if (!files.length || importState.phase === 'running') return
  Object.assign(importState, {
    phase: 'reading', plan: null, result: null, error: '', mode: 'keep',
    fileLabel: files.length === 1 ? files[0].name : `${files.length} 个文件`,
    fileSize: files.reduce((n, f) => n + f.size, 0),
  })
  try {
    current = await toImportFiles(files)
    const plan = await planImport(current, repo)
    importState.plan = plan
    importState.phase = 'ready'
  } catch (e) {
    importState.error = (e as Error).message
    importState.phase = 'idle'
  }
}

export async function runImport() {
  const plan = importState.plan
  if (!plan || importState.phase !== 'ready') return
  importState.phase = 'running'
  importState.done = importState.total = 0
  try {
    importState.result = await enqueue(() =>
      applyImport(plan, repo, {
        mode: importState.mode,
        onProgress: (done, total) => {
          importState.done = done
          importState.total = total
        },
      }),
    )
    await reloadIndex()
    diaryChanged()
    syncAfterEdit()
    importState.phase = 'done'
  } catch (e) {
    // 已经写进去的日记留着（都是手机上原来没有的）；重新算一遍计划，再点导入时会跳过它们
    importState.error = (e as Error).message
    await reloadIndex()
    diaryChanged()
    try {
      importState.plan = await planImport(current, repo)
      // 已经导进去的那几天现在“两边都有”，改回“保留手机上的”，免得再接一遍
      importState.mode = 'keep'
      importState.phase = 'ready'
    } catch {
      importState.phase = 'idle'
    }
  }
}

export function resetImport() {
  if (importState.phase === 'running') return
  current = []
  Object.assign(importState, { phase: 'idle', plan: null, result: null, error: '', fileLabel: '', fileSize: 0 })
}
