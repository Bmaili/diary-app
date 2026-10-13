/**
 * 按需读取的 zip（2026-10-13 起用于导入日记）。
 *
 * 只读文件末尾的中央目录，拿到每个文件的位置；要哪个文件才切出那一段解压。
 * 用户选的文件在 WebView 里是一个 Blob，切片不会把整个 zip 读进内存：照片多、包有几百 MB 也不会因内存不足闪退。
 *
 * - 支持原样存（STORE）和 deflate（用浏览器 / WebView 自带的 DecompressionStream）。
 * - 文件名：标了 UTF-8 的按 UTF-8；没标的先试 UTF-8，不合法再按 GBK（Windows 中文系统压的包）。
 * - 不支持 zip64（超过 4 GB 或 65535 个文件）和加密的 zip，遇到时报错。
 */

export interface RandomAccess {
  size: number
  read(start: number, end: number): Promise<Uint8Array>
}

export function blobAccess(b: Blob): RandomAccess {
  return {
    size: b.size,
    read: async (start, end) => new Uint8Array(await b.slice(start, end).arrayBuffer()),
  }
}

export function bytesAccess(bytes: Uint8Array): RandomAccess {
  return { size: bytes.length, read: async (start, end) => bytes.subarray(start, end) }
}

export interface ZipEntry {
  name: string
  dir: boolean
  method: number
  flags: number
  compSize: number
  size: number
  offset: number
}

const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0

function decodeName(raw: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder().decode(raw)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    try {
      return new TextDecoder('gbk').decode(raw)
    } catch {
      return new TextDecoder().decode(raw)
    }
  }
}

export class ZipError extends Error {}

/** 读中央目录，列出所有文件 */
export async function readZipEntries(src: RandomAccess): Promise<ZipEntry[]> {
  const tailLen = Math.min(src.size, 22 + 0xffff)
  const tail = await src.read(src.size - tailLen, src.size)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError('这不是一个 zip 文件，或者文件不完整')
  const count = u16(tail, eocd + 10)
  const cdSize = u32(tail, eocd + 12)
  const cdOffset = u32(tail, eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('这个 zip 太大了（zip64 格式），暂不支持。可以分成几个小一点的包再导入')
  }
  const cd = await src.read(cdOffset, cdOffset + cdSize)
  const out: ZipEntry[] = []
  let p = 0
  for (let k = 0; k < count; k++) {
    if (u32(cd, p) !== 0x02014b50) throw new ZipError('zip 的目录损坏了')
    const flags = u16(cd, p + 8)
    const method = u16(cd, p + 10)
    const compSize = u32(cd, p + 20)
    const size = u32(cd, p + 24)
    const nameLen = u16(cd, p + 28)
    const extraLen = u16(cd, p + 30)
    const commentLen = u16(cd, p + 32)
    const offset = u32(cd, p + 42)
    const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0).replace(/\\/g, '/')
    out.push({ name, dir: name.endsWith('/'), method, flags, compSize, size, offset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new ZipError('这台手机的系统组件太旧，解不开 zip。请更新“Android System WebView”')
  const ds = new DecompressionStream('deflate-raw')
  const res = new Response(new Blob([data as BlobPart]).stream().pipeThrough(ds))
  return new Uint8Array(await res.arrayBuffer())
}

/** 读出一个文件的内容 */
export async function readZipFile(src: RandomAccess, e: ZipEntry): Promise<Uint8Array> {
  if (e.flags & 1) throw new ZipError(`“${e.name}”是加密的，解不开。请导出不加密的 zip`)
  const head = await src.read(e.offset, e.offset + 30)
  if (u32(head, 0) !== 0x04034b50) throw new ZipError(`zip 里的“${e.name}”损坏了`)
  const start = e.offset + 30 + u16(head, 26) + u16(head, 28)
  const data = await src.read(start, start + e.compSize)
  if (e.method === 0) return data
  if (e.method === 8) return inflateRaw(data)
  throw new ZipError(`“${e.name}”用了不支持的压缩方式。请用手机或电脑自带的压缩功能重新压缩`)
}
