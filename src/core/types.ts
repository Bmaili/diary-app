/** 规格第 4.3 节中由 app 理解的字段。其他字段一律视为“未知字段”，原样保留。 */
export interface Weather {
  text?: string
  temp_c?: number
  [k: string]: unknown
}

export interface Location {
  name?: string
  address?: string
  lat?: number
  lng?: number
  crs?: string
  amap_poi_id?: string
  [k: string]: unknown
}

export interface AiMeta {
  extracted_at?: string
  model?: string
  fields?: string[]
  [k: string]: unknown
}

export type ListField = 'tags' | 'people' | 'places'
export const LIST_FIELDS: ListField[] = ['tags', 'people', 'places']

export interface EntryMeta {
  date: string
  created?: string
  updated?: string
  weather?: Weather
  mood?: number
  location?: Location
  tags?: string[]
  people?: string[]
  places?: string[]
  ai?: AiMeta
  locked?: string[]
  /** 不让 AI 读这篇：问答、总结、抽取都跳过（2026-10-05 加入） */
  ai_exclude?: boolean
}

/** front matter 中已知字段的输出顺序（规格 4.4 第 1 条：按 4.3 表顺序输出）。 */
export const KNOWN_KEYS = [
  'date', 'created', 'updated', 'weather', 'mood', 'location',
  'tags', 'people', 'places', 'ai', 'locked', 'ai_exclude',
] as const

/** 文件系统抽象：真机用 Capacitor Filesystem，测试用 Node fs。路径均相对于 app 数据根目录。 */
export interface FileInfo {
  name: string
  type: 'file' | 'directory'
  size: number
  mtime: number
}

export interface FileStore {
  readText(path: string): Promise<string | null>
  /** 读二进制文件（图片等），返回 base64；不存在时 null */
  readBase64(path: string): Promise<string | null>
  writeText(path: string, data: string): Promise<void>
  /** 写二进制文件（base64） */
  writeBase64(path: string, data: string): Promise<void>
  /** 重命名；目标已存在时允许失败，由调用方处理。 */
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  list(dir: string): Promise<FileInfo[]>
  mkdirp(dir: string): Promise<void>
  stat(path: string): Promise<FileInfo | null>
  /** 删除整个目录（不存在时忽略）。 */
  rmdir(dir: string): Promise<void>
}

/** 索引中的一条记录（规格 4.7）。 */
export interface IndexRow {
  date: string
  path: string
  mtime: number
  size: number
  hash: string
  updated?: string
  mood?: number
  weather?: string
  locationName?: string
  lat?: number
  lng?: number
  tags: string[]
  people: string[]
  places: string[]
  /** AI 上次抽取的时间（ai.extracted_at） */
  extractedAt?: string
  /** 被锁定的字段 */
  locked?: string[]
  /** 正文纯文本（去掉 Markdown 标记），用于搜索和摘要 */
  text: string
  /** 测试数据标记，便于一键清除 */
  test?: boolean
  /** 不让 AI 读（front matter 的 ai_exclude） */
  aiExclude?: boolean
  /** 文件无法解析时的错误信息；此时 app 不会改写该文件 */
  error?: string
}
