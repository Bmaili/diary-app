# 日记 App

自用的安卓日记 app。日记以一天一个 Markdown 文件保存在手机上，任何 Markdown 工具都能读。需求与技术规格见 [SPEC.md](SPEC.md)。

当前进度：**第一阶段（本地写作）已完成**。可以写日记、记心情和标签、看日历、那年今日、搜索、导出 zip。云同步、定位天气、AI 在后续阶段加入。

## 先在电脑浏览器里试用

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

打开终端里显示的地址（通常是 http://localhost:5173），按 F12 切到手机视图。浏览器里的日记存在该网站的本地存储里，只用于试用。

## 打包成安卓 app

1. 安装 [Android Studio](https://developer.android.com/studio)，第一次打开时按向导装好 Android SDK。
2. 在本目录运行：
   ```bash
   npm install
   npm run cap:sync
   npx cap open android
   ```
   这会构建网页、复制到安卓工程，然后用 Android Studio 打开 `android/` 文件夹。第一次打开需要下载 Gradle 依赖，可能要几分钟。
3. 手机开启“开发者选项”和“USB 调试”，用数据线连上电脑，在 Android Studio 顶部选中你的手机，点绿色的运行按钮。

每次改了代码，重新运行 `npm run cap:sync` 再点运行即可。

### 国内网络

工程已改为从国内镜像下载构建工具：Gradle 本体走腾讯云镜像（`android/gradle/wrapper/gradle-wrapper.properties`），依赖库优先走阿里云 Maven 镜像（`android/settings.gradle` 开头），镜像没有的才去官方仓库。

如果仍然下载失败：

- Android Studio 第一次打开时还会下载 Android SDK 组件，这部分走 Google 的服务器，国内一般能连上但可能较慢；如果你有代理，可在 Settings → Appearance & Behavior → System Settings → HTTP Proxy 里填上。
- Gradle 本体也可以手动下载：用浏览器下载 `https://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-bin.zip`，放到 `用户目录/.gradle/wrapper/dists/gradle-8.14.3-bin/<一串随机字符>/` 下（先让它失败一次，这个文件夹就会自动创建），再点 Try Again。

### 正式使用前务必做的事

- **签名文件要备份。** 想长期使用，请在 Android Studio 里用 Build → Generate Signed App Bundle / APK 生成一个签名文件（keystore），并把它和密码另外保存好。签名文件丢了就无法覆盖安装新版本，只能卸载重装，而**卸载会删除手机上的全部日记**。
- **升级时覆盖安装，不要先卸载。**
- 第二阶段的云同步做好之前，请定期在“设置 → 导出为 zip”备份。
- OPPO / vivo / 一加的系统可能会询问是否允许 app 自启动或后台运行，第一阶段不需要这些权限。

## 测试

```bash
npm test              # 单元测试：文件格式、日期、原子写入、索引、搜索性能、导出
npm run build && PLAYWRIGHT_BROWSERS_PATH=<浏览器目录> npm run e2e   # 端到端测试，截图在 e2e/out/
```

端到端测试需要 Playwright 的 Chromium（`npx playwright install chromium`）。

## 第一阶段验收情况

| 验收项 | 状态 | 怎么验证的 |
| --- | --- | --- |
| 导出的 `.md` 完全符合第 4 节 | 已自测 | 单元测试：规格示例读写逐字节一致；端到端：界面写的文件逐字检查格式，导出 zip 与原文件一致 |
| 在 Obsidian 或 Typora 里正常显示 | **需要你验证** | 导出 zip，解压后用 Obsidian 打开 `diary` 文件夹 |
| 强行杀掉 app，最多丢 1 秒输入 | 已自测（浏览器） | 连续打字 4 秒不停顿、立即读盘，丢失约 0.1 秒。**真机需要你验证**：写一段话后立刻从最近任务里划掉 app |
| 手动加的未知字段编辑后仍在 | 已自测 | 单元测试 + 端到端 |
| 凌晨 1 点写的归入前一天 | 已自测 | 单元测试 + 端到端（模拟时钟） |
| 同一天再写追加 `### HH:mm` | 已自测 | 单元测试 + 端到端；没写内容就离开不留空标题 |
| 删除索引后重建结果不变 | 已自测 | 单元测试 + 端到端（3650 篇） |
| 3650 篇搜索 200 毫秒内，中文单字词语都能命中 | 已自测 | 电脑上 2–8 毫秒。**真机需要你验证**：设置里连点版本号 5 次打开开发者选项，生成 3650 篇测试日记后搜索 |
| 那年今日只在往年同日有日记时出现 | 已自测 | 单元测试（含 2 月 29 日）+ 端到端 |

另外两项在真机上值得看一眼：打开编辑页时键盘是否自动弹出；安卓返回键在各页面的行为。

## 和规格不同的地方

- 技术路线改为网页技术 + Capacitor（2026-10-04 决定），SPEC.md 第 3 节已同步更新。
- 本地索引不用数据库，而是内存索引加一个 JSON 缓存文件；3650 篇冷启动重建约 1.5–2 秒，之后只增量更新。
- 插入图片（规格 5.2）不在第一阶段的范围清单里，和天气、位置（5.3、5.4）一起留到后续阶段。
- 自动保存是“有改动后最多 1 秒写一次”，而不是“停止输入 1 秒后写”。后者在持续打字时可能长时间不保存，达不到“最多丢 1 秒”的要求。

## 目录

```
src/core/       数据层（与平台无关，有单元测试）
src/platform/   Capacitor 适配
src/ui/         页面与组件
tests/          单元测试
e2e/            端到端测试
android/        安卓工程（由 Capacitor 生成）
```
