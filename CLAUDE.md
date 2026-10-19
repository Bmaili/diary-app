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
- app 内更新（`updateService.ts`）读 `releases/latest`：标签必须是 `v1.0.N`，安装包名以 `.apk` 结尾（不带 `unsigned`），更新内容取说明里 `---` 之前的部分。改 workflow 的发布步骤时别破坏这几点，否则用户收不到更新提示。
- app 内更新支持断点续传（见 SPEC 5.11），续传靠 sha256 认文件：发布时要保留 GitHub 给的 `digest`。更新代码要等装上之后的下一版才在真机上跑，改 `AppUpdatePlugin.java` 后要跑 `bash e2e/native-update/run.sh`（桩类编译 + 本地 HTTPS 服务器，覆盖断线重试、续传、换版本、不支持分段、sha256 不对、404）全过再推送。
- 在没有 Android SDK 的云端环境里：
  - 不能在本地打安卓包。Java 改动只能用桩类编译检查，最终以 CI 结果为准。
  - 用 `https://api.github.com/repos/<owner>/<repo>/commits/<sha>/check-runs` 查看构建是否成功；`.../check-runs/<id>/annotations` 看失败原因（workflow 失败时会把日志结尾写成 error 注释）。
  - 用 `.../releases` 查看发布结果、下载 APK；签名用 `keytool -printcert -jarfile` 核对，和上一个版本的证书指纹一致才算通过。
  - 改了 `IntakePlugin.java`、`PrintPlugin.java`、`MainActivity.java` 后跑 `bash e2e/native-compile/run.sh`（桩类编译，查拼写、类型、漏 import）；用到新的安卓接口要在 `e2e/native-compile/stubs/` 里补上声明。

## 技术栈

- 网页技术 + Capacitor 8 打包。Vue 3 + TypeScript + Vite + Vue Router（hash 模式）。
- 插件：filesystem、preferences、app、share、keyboard、haptics、network、local-notifications；自写的原生插件 `PrivacyScreenPlugin`（FLAG_SECURE，“防止截屏”默认开，`prefs.privacy.noCapture`，和应用锁无关）、`HttpStreamPlugin`（SSE 流式）、`BiometricPlugin`（指纹，androidx.biometric 1.1.0）、`AppUpdatePlugin`（应用内更新：下载、核对 sha256 / 包名 / 版本 / 签名、调起系统安装界面）、`IntakePlugin`（ACTION_PICK 调相册选图、收别的 app 分享进来的内容，都复制到缓存目录；HEIC 转 JPEG）、`PrintPlugin`（年度日记本：不显示的 WebView 载入网页交给系统打印），在 `MainActivity` 里于 `super.onCreate` 之前注册。Capacitor 的 `PluginCall.getLong` 对 JS 传来的整数会返回默认值，取数字用 `getInt` / `getDouble`。
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
- 图片说明就是 Markdown 替代文字 `![说明](../../attachments/…)`，不新增字段。新插的图是长边 2560 的 `.webp`（2026-10-12 起），旧的 `.jpg` 原样保留；代码里不要假设附件是 JPEG。
- 索引缓存在 `cache/index.json`，同步清单和状态在 `sync/`，问答记录在 `ai/chats.json`，小传里 AI 写的几句在 `ai/portraits.json`。这些都在 `diary/` 之外，可以重建。
- 只记了心情也保存（2026-10-13 起）：文件只有 front matter。“记了没有”统一用 `hasRecord`（正文或心情），自动填的位置天气不算；索引里这种日子 `sections === 0`（`hasBody`），AI 批量标注跳过。
- 珍藏是 `starred: true`（2026-10-13 加入），索引里 `starred`。
- 朱批在 `diary/annotations/YYYY/YYYY-MM-DD.md`（2026-10-13 加入，SPEC 4.9）：front matter 有 `date`、`created`、`model`，正文是批语。不进索引；删除日记时一起进最近删除。
- 写给未来的信在 `diary/letters/<写信日期>_<编号>.md`（2026-10-13 加入，SPEC 4.8）：front matter 有 `written`、`open_on`、`remind`、`opened`；随信的照片在 `letters/img/`，信里写 `![](img/…)`（不放 attachments/，免得删日记时被带走）。不进日记索引，所以 AI、搜索、提示读不到；删除和撤回走 `trashLetter`（最近删除里不露封着的信的内容）。
- 日记可设 `ai_exclude: true`（不让 AI 读）：问答工具（`index.aiRows()`）、总结、批量抽取、图片说明都跳过它，月度总结的源哈希也不算它。
- 删除的日记放在 `trash/<日期>_<时间戳>/`（在 `diary/` 之外，不同步），30 天后启动时清理。没被用到的图片（编辑时去掉的、设置里清理出的，2026-10-14 起，SPEC 4.10）也进最近删除：`trash/images_…/`，`kind: images`，`refs` 记原来的写法，恢复时接回那天日记末尾。删除一律走 `deleteEntryToTrash`，不要直接调 `repo.deleteEntry`（开发者选项清测试数据除外）。
- 详细规格见 `SPEC.md` 第 4 节。改了行为要同步更新 `SPEC.md` 和 `README.md`。

## 代码结构

```
src/core/            与平台无关、有单元测试的逻辑
  entryFile.ts repo.ts diaryIndex.ts session.ts time.ts   文件格式、仓库、索引、编辑会话
  sync/              engine.ts（清单增量、核对云端 reconcile、加密形态切换）
                     oss.ts（V4 签名）github.ts（一次同步一般一个 commit，文件多时每 100 个 / 20 MB 一批）
                     restore.ts（逐个下载、restore-tmp/.progress.json 断点续传）crypto.ts（age 加密）remote.ts
                     （Upload 是按需读取的 read()：上传和恢复都不能把全部文件一起读进内存）
  geo/               坐标转换、高德 Web 服务、和风天气 / Open-Meteo
  llm/               client.ts（OpenAI 兼容与 Anthropic 两种协议；chatText 要正文：空输出报错、截断自动加倍重试；
                     chatJson 要 JSON：约束解码 → 宽松解析 → 请它重写；去掉 <think>）
                     prompts.ts（各功能系统提示词：可编辑部分 + 代码附加的固定部分，用户改过的存 prefs.ai.prompts）
                     personas.ts（灯下的人物：内置六个 + 自定义，各自的首屏问候）
                     tools.ts agent.ts（工具调用问答，计数在代码里做；按上下文长度压缩发送量）
                     stats.ts（aggregate 分组统计）charts.ts（回答里的图表：编号、[[chart:…]] 标记、画法）
                     extract.ts summarize.ts caption.ts（看图写说明，user 消息可带 images）
  mdEdit.ts          编辑快捷按钮与列表续行
  pin.ts reminder.ts lunar.ts（农历节气）holidays.ts（法定节假日：内置 + 联网覆盖）poems.ts（内置诗词）
  summaries.ts vocab.ts trash.ts（最近删除）imageCaption.ts launch.ts（桌面快捷方式链接）
  update.ts（解析 Releases、比较版本）settingsBundle.ts（设置导出文件：age 密码加密的 JSON）
  hints.ts（首页小提示和提醒通知共用的句库：七十二候、时辰、交节、节日节气、彩蛋，分层抽取）
  diaryFacts.ts（首页小提示里引用日记的句子：只用心情 ≥3、非 ai_exclude 的日记）
  wander.ts（随手翻）backupReminder.ts（首页备份提醒的条件）
  zipReader.ts（按需读 zip：Blob 切片 + DecompressionStream，GBK 文件名）importDiary.ts（导入：先 planImport 再 applyImport）
  letters.ts（信的格式、状态、快捷日期、到期提醒的排法）
  shareIn.ts（分享进来的文字怎么拼、接在哪）annotation.ts（朱批的格式、发给模型的内容、清理输出）
  yearbook.ts（年度日记本的“水墨”排版：纯函数出整本 HTML，梅枝、远山、圆相都是 SVG；yearStats 算“这一年”的数）  llm/annotate.ts（朱批）
  orphans.ts（没被用到的图片：离开编辑页时去掉的、手动清理）extractOverview.ts（AI 标注一览的分组）
  answer.ts（问答回答的后处理：相关日期→小笺、接着问→按钮、引文逐字核对、人名地名链接）suggest.ts（问答首屏的推荐问题）
  greeting.ts（灯下输入框上面的问候：人物口吻、节令、日记，和首页小提示共用换句种子）
  bio.ts（人物 / 地点 / 标签小传的统计）llm/portrait.ts（小传里“请 AI 写几句”）
src/platform/        Capacitor 适配：capStore（浏览器里文本要规范化）、nativeHttp
                     （真机直接调 CapacitorHttp 插件，不用它的 fetch 补丁：会损坏二进制）、
                     secrets（WebCrypto 不可导出密钥）、privacy、exportShare、biometric、nativeStream、
                     intake（IntakePlugin：选图、分享进来；缓存文件用 convertFileSrc 读成 Blob）
src/*Service.ts      应用层：sync、place、image、ai、lock、reminder、daily、holiday、launch、update（应用内更新）
                     （界面读农历要用 holidayService 的 `lunar()`，节假日数据更新后才会刷新）
src/backupService.ts 导出 zip（设置页和首页备份提醒共用），记下导出时间
src/importService.ts 导入日记的流程和状态（模块级，离开页面不中断）
src/lettersService.ts 写给未来的信：读写、改日期、撤回、本地通知（编号 300000 起）
src/shareService.ts  分享进来：等读好、解锁后，文字图片交给今天的编辑页（shareInbox + 地址里的 share 编号），zip 走导入
src/yearbookService.ts 年度日记本：读一年的日记、换图片地址、调 Print 插件（浏览器里用 iframe 打印）
src/hintService.ts   首页小提示的换句节奏（回来时隔 30 分钟或跨时段换句，切页面不换）
src/settingsTransfer.ts  导入导出设置：按类收集 prefs 和密钥、导入时整类覆盖（换了 Bucket / 仓库的同步后端先关着）
src/appInfo.ts       应用名、slogan、作者邮箱、仓库地址、致谢列表（关于页用）
src/app.ts           全局：store/repo/index、串行写入队列 enqueue、onStarted/onDiaryChanged 钩子
src/prefs.ts         不含密钥的设置（响应式，自动保存；读取时只合并已有的键，新增对象型设置要把键列全）
src/ui/              views/ 各页面，components/，style.css（主题）settings.css
                     editor/ 编辑页的组合式函数：useEntrySession（打开/自动保存/离开/删除）
                     usePlaceWeather useTextarea（自动增高时保持滚动、光标不被键盘挡住）useImages（插图、说明、看大图）useAiExtract
                     useShareIn（收下分享进来的内容、撤销）useAnnotation（朱批）
                     views/AiView.vue（灯下：聊聊 / 总结 / 整理）PersonaEditView.vue（添加、修改自己的人物）
                     AiTaggedView.vue（整理过的，原“AI 标注一览”）WhoView.vue（小传，/who/<field>/<词>）
                     components/DayNotes.vue（“提到的日子”小笺列表）
                     components/ImageViewer.vue（全屏看图）AnswerChart.vue（问答图表，手写 SVG）
                     backStack.ts（安卓返回键先关覆盖层；Sheet.vue 打开时自动登记，新的覆盖层也要登记）
                     dialog.ts + components/AppDialog.vue（app 自己的提示框：ask / choose / tell / promptText；
                     不要再用 window.confirm / alert / prompt。返回键按 dismiss，dismiss 要设成安全的选项）
tests/               单元测试；tests/mocks/ 下是 OSS、GitHub、LLM 的本地模拟服务器
e2e/                 端到端测试；native-update/ 是应用内更新原生下载逻辑的测试（桩类 + 本地 HTTPS 服务器）；
                     native-compile/ 是其他原生插件的桩类编译检查
                     页面里的异步条件用 page.evaluate 轮询：waitForFunction 不等函数返回的 Promise（会当成成立）
                     autoDialog.mjs：测试里自动点提示框的主按钮（window.__dialogRule 改规则，__noAutoDialog 关掉）
android/             Capacitor 安卓工程（settings.gradle 在非 CI 时用阿里云镜像）
design/              图标源图 icon-enso.svg（各密度 PNG 由它渲染）
docs/screenshots/    README 用的截图：由 e2e/readme.test.ts 用虚构日记和模拟模型拍出（e2e/out/readme-*.png），缩到 390 宽转 JPEG
```

## 设计语言：“宣纸水墨”

- 浅色是米白宣纸（`--paper` 纸纹），墨色文字；深色是砚台夜墨，月白文字。朱砂红 `--accent` 只用于印章（`Seal.vue`）、今天和强调。
- 心情用中国传统色，从冷暗到暖亮：玄青、黛蓝、天青、竹青、杏黄（`--m1`…`--m5`）。不要用红色表示好心情，红色容易被读成生气。深色心情块上用浅色字，见 `.mood-N` 的 `--onm` 和 `mood.ts` 的 `inkOn`。成功和开关用竹青 `--m4`。
- 字体用手机自带的宋体（`--serif`），诗句用楷体（`--kai`），数字用衬线体（`--num`）。不内置字体，免得安装包变大。
- 首页最近 30 天画成一枝梅花（`PlumBranch.vue`）；日历每天显示农历，节气和节日用朱红；首页有每日诗词。
- 意象走古典文艺：明月、星河、灯下、茶、梅这类可以用；不要科幻宇宙、星座占卜这类现代意象。
- 新界面沿用 `style.css` 里的颜色变量和组件（Switch、Sheet、Icon 等），不要引入新的视觉风格。
- 应用图标是宣纸底上的水墨圆相加朱印“记”；改图标要从 `design/icon-enso.svg` 重新渲染各密度 PNG（自适应图标的前景层，加一张纸纹背景位图）。
- 启动图 `res/drawable*/splash.webp` 用 WebP（质量 92，11 张合计不到 0.1 MB）。以前的 PNG 有纸纹噪点压不下去，占了安装包 12.8 MB 里的 9.4 MB。重新生成启动图（例如用 Capacitor 的资源工具）时会输出 PNG，要再转成 WebP 并删掉 PNG（同名的 png 和 webp 并存会打包失败）。

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

- 计数在代码里做（`count_days`、`aggregate` 等工具），模型只负责选词和表述。
- 回答里的图表只画工具结果（`chart_id` → 存下的数据），不要让模型输出图表数字。图表写法放在 `CHART_RULES`（固定部分）。
- 回答里的引文由代码逐字核对（`core/answer.ts` 的 `quoteFound`），对不上就当普通文字；引用写法在 `QUOTE_RULES`（固定部分）。
- 改默认提示词时要注意：用户改过的版本不会跟着变。程序依赖的格式要求放在 `fixed`（由代码附加），不要放进可编辑部分。
- 要正文的调用用 `chatText`，要 JSON 的用 `chatJson`，不要直接用 `chat` 再自己解析。
- 第一次把日记发给某个服务前要征得同意（`ensureConsent`）；`ai_exclude` 的日记任何 AI 功能都不能读。
- 问答的系统提示词 = 可编辑的“问答”一段（只管怎么翻日记）+ 人物一节（身份语气）+ 固定部分（`PERSONA_RULES` 底线、`CHART_RULES`、`QUOTE_RULES`、`TAIL_RULES`：相关日期和接着问的写法）。内置人物不开放修改；新增程序依赖的格式要放进固定部分，不要写进人物或可编辑部分。
- 交给模型的单篇心情用文字（`moodWord`），给数字模型就会报“心情 4 分”；`get_stats` 不带心情。
- 界面上的说法（2026-10-19 起）：AI 页叫“灯下”（聊聊 / 总结 / 整理），“标注”说成“整理”，“词表”说成“人与地”，总结“锁定”说成“定稿”。设置里的 AI 服务配置保持技术说法。编辑页的“AI 标注”按钮还没改。

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
| 一次读入全部文件 | 同步上传、恢复下载都逐个文件处理（`Upload.read()`、`downloadAll` 逐个回调）；GitHub 恢复不用 zipball；照片多了整包进内存会闪退 |
| 覆盖层和返回键 | 自己写的弹层要 `pushBack`，否则返回键会让底下的页面返回，弹层还留在屏幕上 |

## 已知限制与待办

- 没做：桌面小组件、把日记放到手机公共目录（SAF），都需要较多原生代码。
- 已有的图片还不能批量让 AI 写说明。
- 锁定是整个字段锁：手动改过标签后，AI 就不再补标签。是否改成只保护手动加的那几个词，还没定。
- 应用内更新从 GitHub 下载安装包，国内网络可能很慢或下不动；以后可以加一个国内镜像。
- 编辑页按完整地址（含 query）区分组件（`App.vue` 里 router-view 的 key），从一天跳到另一天、或者又分享进来一次时会重新打开。注意同一路由只改 query 时旧页面不走 `onBeforeRouteLeave`，靠 `onBeforeUnmount` 保存。
- “从相册选”靠手机自带相册响应 `ACTION_PICK` 并临时授权读图；个别相册不给授权时退回系统选择器。真机效果以用户反馈为准（云端没法真机测）。
- 年度日记本靠系统打印：照片很多时排版慢、占内存；页数是估的。封面、扉页用无边距的命名页（`@page bare`），书末不要再从普通页换到命名页（Chromium 会多插一张空白页）。楷体靠手机自带，没有就显示成宋体。

## 已商定的后续计划（2026-10-13 和用户确认）

2026-10-19（第二批）：接着问改成用户问 AI（提示词 + 过滤“有你没我”的）；有新版时弹窗提醒（打开 app 或离开超 30 分钟回来，编辑页不弹，解锁后再弹，“暂不”后这一版不再弹，关于页可关）；返回键先关底部面板；GitHub 恢复逐个下载可续传；同步上传随传随读、GitHub 分批提交；搜索挪到首页右上角（同步、搜索、设置）；云端加密默认开（新开的后端；所有后端共用一个密码；已在用明文的不自动改；改成明文在加密密码页最下面并说明后果）。

2026-10-19：AI 页改名“灯下”，问答加人物（老友默认、知音、说书人、损友、元气同桌、猫，可自己添加；内置的不能改）、输入框上面的问候、“接着问”；心情交给模型时用文字，不报分数；页面说法去技术化。用户决定同步合并提交先不做（担心的是 GitHub 仓库空间，算下来提交记录一年只有几 MB 到几十 MB，照片才是大头），“云端已用”也不做。

2026-10-15：AI 页——问答首屏的推荐问题（代码出题）和收藏常问、回答里的日记小笺和逐字核对的原文引文、人名地名可点、人物 / 地点小传（用户从样张里选的：回答用列表小笺，小传用印章名帖加时间线）；词表点一下开小传，合并改成先“选择”。

2026-10-14：寄往来日的文字改成文艺的说法（界面上不讲文件、加密；信是明文这件事写在 SPEC 4.8 和 README 里）、AI 标注一览、去掉的图片进最近删除和手动清理、年度日记本改成用户从三套样张里选的“水墨”版式。

第一批（心情即记、珍藏、随手翻、导入、备份提醒、AI 空状态）、第二批（写给未来的信、首页旧页卡片、app 自己的提示框）和后面的原生一批、年度日记本、朱批都已做（2026-10-13），下面留作记录。之后又按用户意见改了布局：底部导航只剩日记、日历、AI，搜索是首页“写今天”上方的悬浮按钮，珍藏是搜索框右边的星星（没有单独的珍藏集页面了）；寄往来日在日历页下面，故意不显示信的数量和日期，留着到期那天的惊喜；首页诗词和旧页都默认打开。后面几批：

2. 原生代码一批：从别的 app 分享进来（先解锁，打开今天的编辑页、追加 `### HH:mm` 段落，可撤销；zip 分享进来走导入）；选图改用 `ACTION_PICK` 调起手机自带相册（能看到所有文件夹，不需要新权限），保留系统选择器作退路。两者共用“把 content:// 图片复制进日记”的代码。
3. 年度日记本：用安卓系统打印（PrintManager）把排好的网页存成 PDF，不内置字体。可选全年或只要珍藏、放不放照片和总结。
4. 朱批：手动“请批”，不自动触发；批语存 `diary/annotations/`，朱红楷体显示在阅读视图正文下面，可“换一句”“删去”。提示词进“系统提示词”可改；固定部分写明一两句、纯文本，以及心情“不好”“很差”的日子只陪伴、不批评不说教。跳过 `ai_exclude`。
