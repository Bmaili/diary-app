/** 写入 diary/README.md 的格式自述（规格 4.1）。给人和其他程序看，app 每次启动会保持它为最新版本。 */
export const README_MD = `# 日记数据

这个文件夹就是全部日记数据。任何能读 Markdown 的工具都可以直接打开。

## 目录

- \`format.json\`：格式版本，当前为 1。
- \`entries/YYYY/YYYY-MM-DD.md\`：每天一篇日记，没写的日子没有文件。
- \`attachments/YYYY/\`：日记里引用的图片，用相对路径引用。
- \`summaries/monthly/YYYY-MM.md\`、\`summaries/yearly/YYYY.md\`：AI 生成或手写的总结。

## 日记文件

文件开头是 YAML front matter，下面是 Markdown 正文（CommonMark + GFM）。

| 字段 | 含义 |
| --- | --- |
| date | 日期 YYYY-MM-DD，与文件名一致 |
| created / updated | 创建与最后修改时间，ISO 8601 带时区 |
| weather | 天气，如 {text: 晴, temp_c: 28} |
| mood | 心情，1 很差到 5 很好 |
| location | 写日记时所在地，坐标为 WGS-84 |
| tags / people / places | 标签、提到的人、当天去过的地方 |
| ai | 哪些字段的当前值由 AI 生成 |
| locked | 手动改过、AI 不会再覆盖的字段 |

其他字段会被原样保留。

“一天”默认在凌晨 4:00 切换，凌晨写的内容归入前一天。同一天多次书写时，后写的内容以 \`### HH:mm\` 标题追加在正文末尾。
`
