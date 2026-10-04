/**
 * 基于 Capacitor Filesystem 的文件存储。
 * 真机上落在 app 私有目录（Directory.Data，即 filesDir）；在浏览器里调试时由插件自带的 IndexedDB 实现兜底。
 */
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Capacitor } from '@capacitor/core'
import type { FileInfo, FileStore } from '../core/types'
import { fromBase64, fromUtf8, toBase64, utf8 } from '../core/bytes'

const D = Directory.Data

export class CapacitorStore implements FileStore {
  async readText(path: string): Promise<string | null> {
    try {
      const r = await Filesystem.readFile({ path, directory: D, encoding: Encoding.UTF8 })
      return typeof r.data === 'string' ? r.data : await (r.data as Blob).text()
    } catch {
      return null
    }
  }

  async readBase64(path: string): Promise<string | null> {
    // 浏览器调试时插件的 IndexedDB 实现按写入时的原样返回内容：文本文件读出来是文本而不是 base64。
    // 真机上原生实现总是返回 base64，这里让两者一致。
    if (!Capacitor.isNativePlatform() && /\.(md|json|txt)$/i.test(path)) {
      const t = await this.readText(path)
      return t == null ? null : toBase64(utf8(t))
    }
    try {
      const r = await Filesystem.readFile({ path, directory: D })
      if (typeof r.data === 'string') return r.data
      const buf = new Uint8Array(await (r.data as Blob).arrayBuffer())
      let s = ''
      for (const b of buf) s += String.fromCharCode(b)
      return btoa(s)
    } catch {
      return null
    }
  }

  async writeText(path: string, data: string): Promise<void> {
    try {
      await Filesystem.writeFile({ path, data, directory: D, encoding: Encoding.UTF8, recursive: true })
    } catch {
      // 浏览器实现里，两个写入同时创建同一目录会报“目录已存在”；目录就绪后再写一次
      await this.mkdirp(path.slice(0, path.lastIndexOf('/')))
      await Filesystem.writeFile({ path, data, directory: D, encoding: Encoding.UTF8, recursive: false })
    }
  }

  async writeBase64(path: string, data: string): Promise<void> {
    // 与 readBase64 对称：浏览器里文本文件按文本存，免得读出来是 base64
    if (!Capacitor.isNativePlatform() && /\.(md|json|txt)$/i.test(path)) return this.writeText(path, fromUtf8(fromBase64(data)))
    await this.mkdirp(path.slice(0, path.lastIndexOf('/')))
    await Filesystem.writeFile({ path, data, directory: D, recursive: true })
  }

  async rename(from: string, to: string): Promise<void> {
    await Filesystem.rename({ from, to, directory: D, toDirectory: D })
  }

  async remove(path: string): Promise<void> {
    await Filesystem.deleteFile({ path, directory: D })
  }

  async list(dir: string): Promise<FileInfo[]> {
    try {
      const r = await Filesystem.readdir({ path: dir, directory: D })
      return r.files.map((f) => ({
        name: f.name,
        type: f.type === 'directory' ? 'directory' : 'file',
        size: f.size ?? 0,
        mtime: Number(f.mtime ?? 0),
      }))
    } catch {
      return []
    }
  }

  async mkdirp(dir: string): Promise<void> {
    try {
      await Filesystem.mkdir({ path: dir, directory: D, recursive: true })
    } catch {
      /* 已存在 */
    }
  }

  async stat(path: string): Promise<FileInfo | null> {
    try {
      const s = await Filesystem.stat({ path, directory: D })
      return {
        name: path.slice(path.lastIndexOf('/') + 1),
        type: s.type === 'directory' ? 'directory' : 'file',
        size: s.size ?? 0,
        mtime: Number(s.mtime ?? 0),
      }
    } catch {
      return null
    }
  }

  async rmdir(dir: string): Promise<void> {
    try {
      await Filesystem.rmdir({ path: dir, directory: D, recursive: true })
    } catch {
      /* 不存在 */
    }
  }
}
