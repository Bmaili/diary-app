# 给 AI 的项目说明

“浮生记”是一个安卓日记 app（包名 `app.diary.local`），全部代码由 AI 编写。用户文档见 `README.md`，需求与技术规格见 `SPEC.md`。和用户交流用中文。

## 协作方式

- 看到用户的方案有明显漏洞、隐含假设或更好的替代方案时，直接指出，不要只顺着补充。
- 汇报简洁：做了什么、需要用户做什么、要在手机上验证什么。不写实现细节的长篇汇报。
- 不确定、改动大或难以回退的决定先问；明确的小改动直接做。
- **数据安全第一**：任何可能导致日记丢失的操作（卸载重装、换签名、改数据格式）都要事先明确提醒。
- 用户很懒：不要加必填项，默认值要合理。
- 仓库是公开的：提交说明、文档、测试数据里不要写个人信息、密钥、会话链接（例如 Claude-Session 行）。

## 发布流程

- 改完代码 → `npm test` 全过 → 提交 → 推送到 `main`。
- 推送后 GitHub Actions（`.github/workflows/android.yml`）自动执行：单元测试 → 构建网页 → `cap sync` → 签名打包 → 发布到 Releases（标签 `v1.0.<构建序号>`，文件 `diary-1.0.N.apk`）。用户在手机上下载并覆盖安装。只改 `.md`、`docs/` 或 `e2e/` 不触发打包。
- 签名文件**不在仓库里**，CI 从仓库 secrets 读取：`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`（`diary`）、`ANDROID_KEY_PASSWORD`。**绝不能换签名**：换了只能卸载重装，而卸载会删掉手机上的全部日记。
- versionCode = 100 + 构建序号，versionName = 1.0.<构建序号>，设置页底部显示版本（Vite `__APP_VERSION__`）。
- Release 说明取自提交说明（会去掉 `Claude-Session:` 行），所以提交说明的第一行要写成用户能看懂的更新内容。
- 在没有 Android SDK 的云端环境里：
  - 不能在本地打安卓包。Java 改动只能用桩类编译检查，最终以 CI 结果为准。
  - 用 `https://api.github.com/repos/<owner>/<repo>/commits/<sha>/check-runs` 查看构建是否成功；`.../check-runs/<id>/annotations` 看失败原因（workflow 失败时会把日志结尾写成 error 注释）。
  - 用 `.../releases` 查看发布结果、下载 APK；签名用 `keytool -printcert -jarfile` 核对，和上一个版本的证书指纹一致才算通过。

## 技术栈

- 网页技术 + Capacitor 8 打包。Vue 3 + TypeScript + Vite + Vue Router（hash 模式）。
- 插件：filesystem、preferences、app、share、keyboard、haptics、network、local-notifications；自写的原生插件 `PrivacyScreenPlugin`（FLAG_SECURE）、`HttpStreamPlugin`（SSE 流式）、`BiometricPlugin`（指纹，androidx.biometric 1.1.0），在 `MainActivity` 里于 `super.onCreate` 之前注册。
- 主要依赖：yaml（Document API，保留未知字段）、marked + DOMPurify、JSZip、age-encryption、lunar-javascript。
- 测试：vitest（单元测试）、Playwright（端到端测试，手机尺寸 Chromium）。

## 命令

```bash
npm test                     # 单元测试，提交前必须全过
npm run build                # vue-tsc 类型检查（开了 noUnusedLocals/Parameters）+ vite 构建
npm run dev                  # 浏览器里预览（数据存在浏览器的 IndexedDB）
PLAYWRIGHT_BROWSERS_PATH=<浏览器目录> npm run e2e          # 第 1 组端到端测试（需先 build）
PLAYWRIGHT_BROWSERS_PATH=<浏览器目录> npm run e2e:stages   # 其余端到端测试，截图在 e2e/out/
npm run cap:sync             # 构建并同步到 android/
```

改界面后要看截图（`e2e/out/`），亮色、暗色都看，确认没有布局问题。端到端测试用 `reducedMotion: 'reduce'` 关掉动画再截图；要看动画效果，得另外开着动画截图。OSS、GitHub、高德、天气、LLM 在测试里都用本地模拟服务器（`tests/mocks/`）。

## 数据格式（已冻结：只能加字段，不能改已有字段的含义）

- `diary/` 是唯一数据源，在 app 私有目录。
  - 日记文件：`entries/YYYY/YYYY-MM-DD.md`，YAML front matter 加 Markdown 正文。
  - 其他：`attachments/YYYY/` 放图片，`summaries/` 放 AI 总结，`format.json`，`README.md`。
- 一天从凌晨 4 点开始（可设置）。同一天再次写作时，追加 `### HH:mm` 段落（标题下面不空行）。
- 写文件都是原子写入（先写 tmp 再 rename）。必须保留用户手动添加的未知字段。
- AI 写回时不更新 `updated`，并记录 `ai.extracted_at`。手动改过的 `tags/people/places` 字段整个进入 `locked`，AI 不再覆盖。
- 图片说明就是 Markdown 替代文字 `![说明](../../attachments/…)`，不新增字段。
- 索引缓存在 `cache/index.json`，同步清单和状态在 `sync/`，问答记录在 `ai/chats.json`。这些都在 `diary/` 之外，可以重建。
- 日记可设 `ai_exclude: true`（不让 AI 读）：问答工具（`index.aiRows()`）、总结、批量抽取、图片说明都跳过它，月度总结的源哈希也不算它。
- 删除的日记放在 `trash/<日期>_<时间戳>/`（在 `diary/` 之外，不同步），30 天后启动时清理。删除一律走 `deleteEntryToTrash`，不要直接调 `repo.deleteEntry`（开发者选项清测试数据除外）。
- 详细规格见 `SPEC.md` 第 4 节。改了行为要同步更新 `SPEC.md` 和 `README.md`。

## 代码结构

```
src/core/            与平台无关、有单元测试的逻辑
  entryFile.ts repo.ts diaryIndex.ts session.ts time.ts   文件格式、仓库、索引、编辑会话
  sync/              engine.ts（清单增量、核对云端 reconcile、加密形态切换）
                     oss.ts（V4 签名）github.ts（一次同步一个 commit）
                     restore.ts crypto.ts（age 加密）remote.ts
  geo/               坐标转换、高德 Web 服务、和风天气 / Open-Meteo
  llm/               client.ts（OpenAI 兼容与 Anthropic 两种协议；chatText 要正文：空输出报错、截断自动加倍重试；
                     chatJson 要 JSON：约束解码 → 宽松解析 → 请它重写；去掉 <think>）
                     prompts.ts（各功能系统提示词：可编辑部分 + 代码附加的固定部分，用户改过的存 prefs.ai.prompts）
                     tools.ts agent.ts（工具调用问答，计数在代码里做；按上下文长度压缩发送量）
                     extract.ts summarize.ts caption.ts（看图写说明，user 消息可带 images）
  mdEdit.ts          编辑快捷按钮与列表续行
  pin.ts reminder.ts lunar.ts（农历节气）holidays.ts（法定节假日：内置 + 联网覆盖）poems.ts（内置诗词）
  summaries.ts vocab.ts trash.ts（最近删除）imageCaption.ts launch.ts（桌面快捷方式链接）
src/platform/        Capacitor 适配：capStore（浏览器里文本要规范化）、nativeHttp
                     （真机直接调 CapacitorHttp 插件，不用它的 fetch 补丁：会损坏二进制）、
                     secrets（WebCrypto 不可导出密钥）、privacy、exportShare、biometric、nativeStream
src/*Service.ts      应用层：sync、place、image、ai、lock、reminder、daily、holiday、launch
                     （界面读农历要用 holidayService 的 `lunar()`，节假日数据更新后才会刷新）
src/appInfo.ts       应用名、slogan、作者邮箱、仓库地址、致谢列表（关于页用）
src/app.ts           全局：store/repo/index、串行写入队列 enqueue、onStarted/onDiaryChanged 钩子
src/prefs.ts         不含密钥的设置（响应式，自动保存；读取时只合并已有的键，新增对象型设置要把键列全）
src/ui/              views/ 各页面，components/，style.css（主题）settings.css
                     editor/ 编辑页的组合式函数：useEntrySession（打开/自动保存/离开/删除）
                     usePlaceWeather useTextarea useImages useAiExtract
tests/               单元测试；tests/mocks/ 下是 OSS、GitHub、LLM 的本地模拟服务器
e2e/                 端到端测试
android/             Capacitor 安卓工程（settings.gradle 在非 CI 时用阿里云镜像）
design/              图标源图 icon-enso.svg（各密度 PNG 由它渲染）
docs/screenshots/    README 用的截图：由 e2e/readme.test.ts 用虚构日记和模拟模型拍出（e2e/out/readme-*.png），缩到 390 宽转 JPEG
```

## 设计语言：“宣纸水墨”

- 浅色是米白宣纸（`--paper` 纸纹），墨色文字；深色是砚台夜墨，月白文字。朱砂红 `--accent` 只用于印章（`Seal.vue`）、今天和强调。
- 心情用中国传统色，从冷暗到暖亮：玄青、黛蓝、天青、竹青、杏黄（`--m1`…`--m5`）。不要用红色表示好心情，红色容易被读成生气。深色心情块上用浅色字，见 `.mood-N` 的 `--onm` 和 `mood.ts` 的 `inkOn`。成功和开关用竹青 `--m4`。
- 字体用手机自带的宋体（`--serif`），诗句用楷体（`--kai`），数字用衬线体（`--num`）。不内置字体，免得安装包变大。
- 首页最近 30 天画成一枝梅花（`PlumBranch.vue`）；日历每天显示农历，节气和节日用朱红；首页有每日诗词。
- 不要引入星空、星座、月相、宇宙类意象。
- 新界面沿用 `style.css` 里的颜色变量和组件（Switch、Sheet、Icon 等），不要引入新的视觉风格。
- 应用图标是宣纸底上的水墨圆相加朱印“记”；改图标要从 `design/icon-enso.svg` 重新渲染各密度 PNG（自适应图标的前景层，加一张纸纹背景位图）。

## 性能与动效

- 动效在 `src/ui/motion.ts` 和 `style.css` 末尾：View Transitions 页面切换和列表→正文的共享元素、列表第一次进屏时浮现（`v-reveal`）、日历跟手换月、梅枝开花、首页飘落花瓣。设置里可以关（`prefs.ui.motion`），系统开了“减少动画”时自动关闭。
- 不要用 `background-attachment: fixed`：滚动时每帧都要重绘纸纹。
- 不要给列表的每一条挂常驻动画：滚动驱动动画会让每一条成为独立图层（实测 200 多个图层，滚动卡顿）。进场动画用 `v-reveal`（`ui/reveal.ts`），只跑一次。
- 会横向位移的元素，外面要套一层 `overflow: hidden`：否则页面会临时变宽，安卓 WebView 会挪动底部导航。
- keep-alive 的页面（首页、日历、搜索、AI）从别的页面回来时，DOM 会被重新插回页面，**CSS 动画会全部重播**。进场动画要只在第一次播（首页用 `.intro` 类，`PlumBranch` 用 `intro` 属性，之后只有新开的花有动画）。
- 首页的日记条目用 `content-visibility: auto`：屏幕外的条目不排版、不绘制，回到首页时不用把几百条全部重排。
- 回到页面时会触发的计算，结果没变就不要重新赋值（例如首页的总结提示），否则整页重新渲染。
- 阅读视图的图片在真机上用 `Capacitor.convertFileSrc` 直接读文件，不要再把图片转成 base64 存在 JS 里。
- 大文件（导出 zip）要边读边写（`core/zipWriter.ts` + `platform/exportShare.ts` 的 `openExport`），不要在内存里拼出整个文件再通过插件通道传给原生端：图片多了会因内存不足闪退。
- 索引缓存只在切到后台时写盘（见 `app.ts`），不要在前台定时写。
- 端到端测试等 app 就绪用 `document.querySelector('.shell')`；启动画面的文字会变成索引进度。
- View Transitions 的页面动画要 `animation-fill-mode: both`（切换要等所有动画结束才收尾，不停住的话旧页面会弹回来闪一下）；滑出屏幕的页面带的阴影要在最后淡掉，否则停在屏幕边上再突然消失。逐帧检查的做法：CDP `Animation.setPlaybackRate` 放慢 10 倍 + `Page.startScreencast` 录帧，看屏幕边缘的亮度有没有突变。
- 编辑会话记着打开时的原文（`session.originalRaw`）：改回原样时写回原文（`revertedRaw`），文件一字不差，同步不会再传。
- 性能剖析的做法：Playwright + CDP 的 `Emulation.setCPUThrottlingRate`（4 倍降速）加 3650 篇测试日记，记录 longtask、rAF 帧间隔和 trace 里的 Layout / Paint；无头 Chromium 体现不出安卓上的合成与光栅开销，横滑类问题以真机为准。

## AI 功能的约定

- 计数在代码里做（`count_days` 等工具），模型只负责选词和表述。
- 改默认提示词时要注意：用户改过的版本不会跟着变。程序依赖的格式要求放在 `fixed`（由代码附加），不要放进可编辑部分。
- 要正文的调用用 `chatText`，要 JSON 的用 `chatJson`，不要直接用 `chat` 再自己解析。
- 第一次把日记发给某个服务前要征得同意（`ensureConsent`）；`ai_exclude` 的日记任何 AI 功能都不能读。

## 常见的坑

| 坑 | 正确做法 |
| --- | --- |
| 国产手机没有 Google Play 服务 | 不用依赖 GMS 的插件；定位用 WebView 的系统定位，地址用高德 Web 服务 |
| YAML 解析丢字段 | 用 yaml 的 Document API，只改已知字段，未知字段原样输出 |
| 坐标系 | 文件里一律存 WGS-84；调高德 Web API 前转 GCJ-02 |
| 和风天气地址 | 新版和风天气用控制台分配的专属 API Host，不要写死公共域名 |
| 后台被杀 | 同步状态靠清单对比算出，不存在内存或队列里；不要依赖后台定时任务 |
| 工具调用格式不同 | OpenAI 兼容接口的 `tool_calls.arguments` 是 JSON 字符串，Anthropic 是 `tool_use` 内容块，统一在 `client.ts` 里处理 |
| 日期时区 | 统一用 `src/core/time.ts`，按设备时区和“一天切换时刻”计算日记日期 |
| 搜索 | 内存里逐篇子串匹配就够快，不要引入全文索引或分词库 |
| CapacitorHttp 的 fetch 补丁 | 会损坏二进制请求体（图片上传），直接调插件 |

## 已知限制与待办

- 没做：桌面小组件、把日记放到手机公共目录（SAF），都需要较多原生代码。
- 编辑时删掉图片引用后，图片文件还留着（删除整篇日记时会带走这天的图片）。
- 已有的图片还不能批量让 AI 写说明。
- 锁定是整个字段锁：手动改过标签后，AI 就不再补标签。是否改成只保护手动加的那几个词，还没定。
- 只拖了心情、没写正文的日子不保存。
