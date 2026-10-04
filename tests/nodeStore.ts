/** 测试用：把 FileStore 映射到磁盘上的临时目录，行为与真机一致（含原子重命名）。 */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { FileInfo, FileStore } from '../src/core/types'

export class NodeStore implements FileStore {
  /** 模拟某些安卓实现：重命名到已存在的文件会失败 */
  renameRefusesOverwrite = false

  constructor(readonly root: string) {}

  static async temp(): Promise<NodeStore> {
    return new NodeStore(await fs.mkdtemp(nodePath.join(os.tmpdir(), 'diary-test-')))
  }

  abs(p: string) {
    return nodePath.join(this.root, p)
  }

  async readText(p: string) {
    try {
      return await fs.readFile(this.abs(p), 'utf8')
    } catch {
      return null
    }
  }

  async readBase64(p: string) {
    try {
      return (await fs.readFile(this.abs(p))).toString('base64')
    } catch {
      return null
    }
  }

  async writeText(p: string, d: string) {
    await fs.mkdir(nodePath.dirname(this.abs(p)), { recursive: true })
    await fs.writeFile(this.abs(p), d, 'utf8')
  }

  async writeBase64(p: string, d: string) {
    await fs.mkdir(nodePath.dirname(this.abs(p)), { recursive: true })
    await fs.writeFile(this.abs(p), Buffer.from(d, 'base64'))
  }

  async rename(a: string, b: string) {
    if (this.renameRefusesOverwrite && (await this.stat(b))) throw new Error('destination exists')
    await fs.rename(this.abs(a), this.abs(b))
  }

  async remove(p: string) {
    await fs.unlink(this.abs(p))
  }

  async list(dir: string): Promise<FileInfo[]> {
    try {
      const names = await fs.readdir(this.abs(dir))
      const out: FileInfo[] = []
      for (const n of names) {
        const s = await fs.stat(this.abs(`${dir}/${n}`))
        out.push({ name: n, type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs })
      }
      return out
    } catch {
      return []
    }
  }

  async mkdirp(dir: string) {
    await fs.mkdir(this.abs(dir), { recursive: true })
  }

  async stat(p: string): Promise<FileInfo | null> {
    try {
      const s = await fs.stat(this.abs(p))
      return { name: nodePath.basename(p), type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtimeMs }
    } catch {
      return null
    }
  }

  async rmdir(dir: string) {
    await fs.rm(this.abs(dir), { recursive: true, force: true })
  }
}
