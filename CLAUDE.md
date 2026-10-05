# 给 Claude 的项目说明

这是用户自用的安卓日记 app，全部代码由 AI 编写。用户是工作三年的软件工程师、AI 爱好者，喜欢天文和前沿科技，自称有点懒。和用户交流用中文。

## 和用户协作的方式

- **用户的长期偏好（原话）**：“当我提出观点、方案或判断时，请不要只是顺着我的思路补充。如果你看到明显的漏洞、隐含假设或更好的替代方案，请直接指出。”
- 用户不想看实现细节的长篇汇报：说清楚做了什么、需要他做什么、要在手机上验证什么。
- 不确定、改动大或难以回退的决定先问；明确的小改动直接做。
- 数据安全第一：任何可能导致日记丢失的操作（卸载重装、换签名、改数据格式）都要事先明确提醒。

## 发布流程（重要）

- 仓库：`Bmaili/diary-app`（私有），主分支 `main`。改完代码 → 跑测试 → 提交 → 推送到 main。
- 推送后 GitHub Actions（`.github/workflows/android.yml`）自动执行：单元测试 → 构建网页 → `cap sync` → 签名打包 → 发布到 Releases（`v1.0.<构建序号>`，文件 `diary-1.0.N.apk`）。用户在手机上下载并覆盖安装。只改 `.md` 或 `e2e/` 不触发打包。
- 签名文件**不在仓库里**。CI 从仓库 secrets 读取：`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`（diary）、`ANDROID_KEY_PASSWORD`。证书 SHA-256 指纹 `27:C9:45:7F:0F:79:76:38:BE:83:F4:A6:51:26:25:75:A6:9B:86:1E:35:62:B8:E7:DE:F2:95:E1:7C:0A:53:8A`。**绝不能换签名**：换了用户只能卸载重装，卸载会删掉手机上的全部日记。
- versionCode = 100 + 构建序号，versionName = 1.0.<构建序号>，设置页底部显示版本（Vite `__APP_VERSION__`）。
- 在 Claude 的云端环境里：
  - 可以用 `curl https://api.github.com/repos/Bmaili/diary-app/commits/<sha>/check-runs` 查看构建是否成功；
  - 用 `.../check-runs/<id>/annotations` 看失败原因：workflow 失败时会把日志结尾写成 error 注释；
  - 用 `.../releases` 查看发布结果，并可下载 APK；签名可用 `keytool -printcert -jarfile` 核对。
  - **Actions 相关的 API（日志、secrets、手动触发）被代理拦截，无法访问。**
  - 环境里没有 Android SDK，也连不上 Google 和 Gradle 的服务器，不能在本地打安卓包。Java 改动只能用桩类编译检查，最终以 CI 结果为准。

## 技术栈

- 网页技术 + Capacitor 8 打包。Vue 3 + TypeScript + Vite + Vue Router（hash 模式）。
- 插件：filesystem、preferences、app、share、keyboard、haptics、network、local-notifications，以及自写的 `PrivacyScreen`（Java，FLAG_SECURE）。
- 主要依赖：yaml（Document API，保留未知字段）、marked + DOMPurify、JSZip、age-encryption。
- 测试：vitest（单元测试）、Playwright（端到端测试，手机尺寸 Chromium）。

## 命令

```bash
npm test                     # 单元测试（约 165 项），提交前必须全过
npm run build                # vue-tsc 类型检查 + vite 构建
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run e2e          # 第 1 阶段端到端（需先 build）
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run e2e:stages   # 其余端到端，截图在 e2e/out/
npm run cap:sync             # 构建并同步到 android/
```

改界面后要看截图（`e2e/out/`），亮色、暗色都看，确认没有布局问题。

## 数据格式（已冻结，只能加字段，不能改已有含义）

- `diary/` 是唯一数据源，在 app 私有目录。
  - 日记文件：`entries/YYYY/YYYY-MM-DD.md`，YAML front matter 加 Markdown 正文。
  - 其他：`attachments/YYYY/` 放图片，`summaries/` 放 AI 总结，`format.json`，`README.md`。
- 一天从凌晨 4 点开始（可设置）。同一天再次写作时，追加 `### HH:mm` 段落。
- 写文件都是原子写入（先写 tmp 再 rename）。必须保留用户手动添加的未知字段。
- AI 写回时不更新 `updated`，并记录 `ai.extracted_at`。手动改过的 `tags/people/places` 字段整个进入 `locked`，AI 不再覆盖。
- 索引缓存在 `cache/index.json`，同步清单和状态在 `sync/`，问答记录在 `ai/chats.json`。这些都在 `diary/` 之外，可以重建。
- 日记可设 `ai_exclude: true`（不让 AI 读）：问答工具（`index.aiRows()`）、总结、批量抽取都跳过，月度总结的源哈希也不算它。
- 删除的日记在 `trash/<日期>_<时间戳>/`（diary/ 之外，不同步），30 天后启动时清理。删除一律走 `deleteEntryToTrash`，不要直接 `repo.deleteEntry`（开发者选项清测试数据除外）。
- 详细规格见 `SPEC.md`，用户文档见 `README.md`。和规格不同的地方，两份文档里都有注明，改动时同步更新。

## 代码结构

```
src/core/            与平台无关、有单元测试的逻辑
  entryFile.ts repo.ts diaryIndex.ts session.ts time.ts   文件格式、仓库、索引、编辑会话
  sync/              engine.ts（清单增量、核对云端 reconcile、加密形态切换）
                     oss.ts（V4 签名）github.ts（一次同步一个 commit）
                     restore.ts crypto.ts（age 加密）remote.ts
  geo/               坐标转换、高德 Web 服务、和风天气 / Open-Meteo
  llm/               client.ts（OpenAI 兼容与 Anthropic 两种协议）
                     tools.ts agent.ts（工具调用问答，计数在代码里做；按上下文长度压缩发送量）
                     extract.ts summarize.ts
  mdEdit.ts          编辑快捷按钮与列表续行
  pin.ts reminder.ts astro.ts（只剩日期差，月相已不用）lunar.ts（农历节气）poems.ts（内置诗词）summaries.ts vocab.ts trash.ts（最近删除）
src/platform/        Capacitor 适配：capStore（浏览器里文本要规范化）、nativeHttp
                     （真机直接调 CapacitorHttp 插件，不用它的 fetch 补丁：会损坏二进制）、
                     secrets（WebCrypto 不可导出密钥）、privacy、exportShare
src/*Service.ts      应用层：sync、place、image、ai、lock、reminder
src/app.ts           全局：store/repo/index、串行写入队列 enqueue、onStarted/onDiaryChanged 钩子
src/prefs.ts         不含密钥的设置（响应式，自动保存）
src/ui/              views/ 各页面，components/，style.css（主题）settings.css
tests/               单元测试；tests/mocks/ 下是 OSS、GitHub、LLM 的本地模拟服务器
e2e/                 端到端测试
android/             Capacitor 安卓工程（settings.gradle 在非 CI 时用阿里云镜像）
```

## 设计语言：“宣纸水墨”（2026-10-05 起，用户要求去掉所有天文宇宙元素）

- 浅色是米白宣纸（`--paper` 纸纹），墨色文字；深色是砚台夜墨，月白文字。朱砂红 `--accent` 只用于印章（`Seal.vue`）、今天、强调。
- 心情用中国传统色：玄青、黛、缃、竹青、胭脂（`--m1`…`--m5`；深色心情上用浅字，见 `.mood-N` 的 `--onm` 和 `mood.ts` 的 `inkOn`）。成功 / 开关用竹青 `--m4`。
- 字体用手机自带宋体（`--serif`），诗句用楷体（`--kai`），数字用衬线体（`--num`）。用户选择不内置字体（不想安装包变大）。
- 首页最近 30 天画成一枝梅花（`PlumBranch.vue`），写一天开一朵；日历每天显示农历（`core/lunar.ts`，lunar-javascript），节气和节日朱红；首页有每日诗词（`core/poems.ts` 内置库 + 可选今日诗词接口，`dailyService.ts`）。
- 不要再引入星空、星座、月相、宇宙类意象。
- 新界面沿用 `style.css` 里的颜色变量和组件（Switch、Sheet、Icon 等），不要引入新的视觉风格。
- 用户很懒：不要加必填项；默认值要合理。

## 已实现的功能

- 本地写作：心情拖动条、标签、人物和地点、日历、那年今日、搜索、导出 zip。
- 同步：阿里云 OSS、GitHub 私有仓库，可以都开、只开一个或都不开；自动同步（停笔 N 分钟后传，默认 2，切到后台时有待传就传；端到端测试里设 `__diary.prefs.sync.quietMin = 0`）；从云端恢复。
- 高德、和风、OSS、GitHub 配置处有可展开的教程（`HelpTip.vue`）。定位先 GPS、超时退回网络定位。
- 核对云端：每周自动加手动，云端缺失或改动的文件会补传。
- 云端加密：每个后端单独开关，默认关闭；age 格式。
- 位置与天气：高德附近地点；插图。
- AI：问答、抽取（标注）、月度和年度总结、词表合并、补充说明（共用 + 分功能）、服务高级设置（上下文长度、最大输出、温度、超时、额外参数）、token 用量显示。
- 删除日记（编辑页按钮）+ 最近删除（30 天）。阅读视图单个换行即换行（`src/ui/markdown.ts`）。
- 编辑页：已写过的日记默认阅读视图（双击或点笔进入编辑）；心情卡片上方是位置和天气（点开编辑框，天气不再点一下就重新获取），下方显示标签/人物/去过的地方，卡片外是操作按钮；插图可选拍照（`capture` 属性 + manifest 里的 `<queries>`）或相册。
- 动效（`src/ui/motion.ts` + `style.css` 末尾）：View Transitions 页面切换和列表→正文共享元素、滚动驱动的列表入场、日历跟手换月、梅枝开花、首页飘落花瓣。设置里可关（`prefs.ui.motion`），系统“减少动画”时自动关。端到端测试用 `reducedMotion: 'reduce'` 关掉动画再截图；要看动画效果得另外开着动画截图。
- 写日记提醒、PIN 应用锁，可选指纹解锁（`BiometricPlugin.java` + `platform/biometric.ts`，依赖 androidx.biometric 1.1.0；端到端测试用 `window.__biometricMock`）。
- AI 问答流式输出（`HttpStreamPlugin.java` + `platform/nativeStream.ts`，`core/http.ts` 的 `httpStream`；`client.ts` 里 SSE 解析，服务不支持时自动退回普通请求），可停止。月度总结超出上下文时按周分段再合成（`summarize.ts` 的 `chunkEntries`）。
- 编辑快捷栏：加粗、列表、编号、待办、引用、时间、插图、撤销；回车续行；阅读视图里可勾选待办。
- 自动打包发布。

## 还没定的事 / 待办

- **待用户决定**：
  - 锁定是整个字段锁（规格 4.6；现状是手动加一个标签后，AI 就不再补标签），还是改成只保护手动加的那几个词；
  - 只拖了心情、没写正文的日子，要不要也保存（现状不保存）。
- **需要用户在真机上验证**：
  - 输入法下回车能否续行、按钮条是否贴住键盘；拍照插图；动效在真机上是否流畅；指纹解锁；流式回答和停止；
  - 提醒能否按时弹出、应用锁、定位和附近地点；
  - 真实 OSS / GitHub / AI 服务能否跑通；从加密云端恢复。
- **没做**：
  - 桌面小组件、把日记放到公共目录（SAF）——需要较多原生代码；
  - 清理没有被引用的图片（编辑时删掉图片引用后留下的；删除整篇时会带走这天的图片）；
  - 可选：打包时同时把 APK 上传到 OSS，方便国内下载。
