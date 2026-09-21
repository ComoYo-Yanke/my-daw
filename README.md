# my-daw

个人自用的桌面 DAW，按 FL Studio 的工作流组织：Channel Rack / Piano Roll / Pattern / Playlist。

不做：实时 MIDI 演奏、VST 托管、自动更新、云同步、多用户。

**中文** · [English](#english)

---

# 中文

## 环境要求

- **Node.js `^20.19.0` 或 `>=22.12.0`**（electron-vite 5 的要求）
- Windows / macOS / Linux

## 启动

```bash
npm install
npm run dev
```

- `npm install` 第一次会下载 Electron 二进制（上百 MB），要等一会儿；装完会自动跑 `electron-builder install-app-deps`。
- 网络不通时 npm 需要走代理，配在 `.npmrc` 里的 `proxy` / `https-proxy`。代理软件没开的话 `install` 会直接 `ECONNREFUSED`，不是包的问题。
- `npm run dev` 带热更新：改 `renderer` 保存即生效，改 `main` / `preload` 会自动重启。

其它命令：

| 命令                | 做什么                                   |
| ------------------- | ---------------------------------------- |
| `npm run build`     | 类型检查后编译到 `out/`，**不**打安装包  |
| `npm start`         | 跑 `out/` 里已编译的产物（要先 `build`） |
| `npm run typecheck` | 类型检查，node 和 web 两套 tsconfig 都跑 |
| `npm run lint`      | ESLint                                   |
| `npm run format`    | Prettier 写回                            |

## 打包

```bash
npm run build:unpack   # → dist/win-unpacked/   免安装，双击里面的 exe 直接跑
npm run build:win      # → dist/my-daw-1.0.0-setup.exe   NSIS 安装包
npm run build:mac      # 只能在 macOS 上执行
npm run build:linux
```

产物在 `dist/`；`out/` 是 electron-vite 的编译结果，是中间产物。打包产物不含 `src/`。

几个要注意的：

- **第一次打包会去 GitHub 下额外的二进制**（`winCodeSign`、`nsis`），国内要挂代理。下完缓存在 `%LOCALAPPDATA%\electron-builder\Cache`，之后不再下。
- **`build:mac` / `build:linux` 不跑类型检查**，只有 `build:win` 跑（因为 `build` 脚本里带了 `typecheck`，而这两个脚本直接调 `electron-vite build`）。这是脚手架自带的差异——跨平台打包前先手动 `npm run build` 一次，否则类型错误会被漏过去。
- `electron-builder.yml` 里的 `publish` 指向 `example.com/auto-updates`，本项目不做自动更新，可以删掉。
- 想自测打包结果又不想装一遍，用 `build:unpack`，快得多。

## 提示

### 采样

两套采样，都在「采样库」窗口里，上下排着。

**内置库**（Drums / Guitar / Piano，共 17 个）是代码合成的，点一下就在机架上建一个通道并试听，不涉及任何文件。Drums 默认展开，其余收起。

**自己的文件夹**：点「选择采样目录」，指向一个装着音频的文件夹。

- 只扫**一层**。子文件夹名就是分类名，直接躺在根目录下的文件归到「（根目录）」。
- 认得的格式：`wav` `mp3` `ogg` `oga` `opus` `flac` `m4a` `aac` `webm`。
- 扫描只列目录，**不解码**；点哪一个才读哪一个。所以指向一个上千文件的目录，开软件也不卡。
- 往目录里丢了新文件，点「刷新」。
- 目录路径记在 `%APPDATA%\my-daw\settings.json`（macOS：`~/Library/Application Support/my-daw/`），**不进工程文件**。换目录不影响已有工程。
- **建议放 one-shot，不要放 loop**。这是采样器不是切片器，一个循环素材会被整段塞进一个音符里。
- 哪里下素材：Freesound（筛选 CC0）、MusicRadar SampleRadar、GitHub 上的 `pumodi/open-samples`。注意 **CC0 ≠ 所有 CC**：CC-BY 要署名，CC-NC 不能商用。

### 导出

工具栏「导出音频」。范围**固定是整首 Song**，没有「只导当前 Pattern」这个选项。

选项：格式（WAV / MP3）、采样率（44100 / 48000）、WAV 位深（16 / 24-bit）或 MP3 码率（128–320 kbps）、速度（BPM）、响度（dB）、尾部留白（秒）、峰值归一化到 −1 dBFS。

渲染规则：

- 用的是和播放**同一套时间线展开逻辑**。软件里怎么响，导出就怎么渲染——不是两条各写一遍的路径。
- 包含每个通道当前的音量、声像、静音、solo，以及 Playlist 上轨道的静音 / solo。
- **只渲染钢琴卷帘里的音符**。Song 模式下步进网格本来就不发声，导出也不包含它。这不是导出层的取舍，是播放本身的行为。
- 时长 = Song 总长度 + 尾部留白。

几个坑：

- **先到 Song 窗口把 Pattern 拖到 Playlist 上**。时间线上没有片段时导出按钮是灰的。
- 保存对话框在渲染**之前**弹出。渲染是慢的那一步，如果最后才问保存位置，取消了就等于白渲染一遍。
- **渲染中不能关窗口**，Esc 也不响应。
- 改「速度」是**重新排版**，不是变速不变调：片段按新 BPM 重新算长度，采样本身音高不变，听感就是整首歌变快 / 变慢。工程自己的 BPM 不受影响。
- 响度 `0 dB` 是原始音量。峰值归一化给整段乘一个系数，不改变各通道的相对比例，只是把最高点抬到 −1 dBFS。

### 文件

- 工程后缀 `.mydaw`，内容是 JSON。
- **工程里存的是采样文件的路径，不是音频数据**。所以工程文件很小，但采样被移动或删除后打开工程，那一行会显示「采样缺失」——通道还在、位置还在，把文件放回原处就能对上（路径不会被抹掉，再保存也不会丢）。
- 缺采样的通道**会被排除出导出**，不会被当成一段静音。
- Ctrl+S 保存，Ctrl+O 打开，Ctrl+Z 撤销。工具栏「文件」菜单里有「新建 / 打开… / 保存 / 另存为…」，工程名显示在菜单按钮右边，有未保存改动时后面跟一个 `•`。
- 「新建」和「打开」会弹系统对话框问是否放弃未保存的改动。这是主进程弹的原生对话框，不是窗口里画的——免得点「新建」的那一下顺手把问题也点没了。
- **撤销是快照式的，只装工程本身**。Song 窗口里拖动播放线**不进撤销、也不算改动**，所以只挪了播放线不会提示保存。
- 导出**不会**自动保存工程。

## 快捷键

| 键          | 作用                                                                |
| ----------- | ------------------------------------------------------------------- |
| `Space`     | 播放 / 停止。开着钢琴卷帘就播卷帘，Song 模式播 Song，否则播步进循环 |
| `Ctrl+Z`    | 撤销                                                                |
| `Ctrl+S`    | 保存                                                                |
| `Ctrl+O`    | 打开                                                                |
| `Ctrl+滚轮` | 钢琴卷帘 / Song 窗口里横向缩放                                      |
| `Ctrl+A`    | 钢琴卷帘里全选音符                                                  |
| `Ctrl+拖动` | Song 窗口里拖动片段 = 复制                                          |
| `F12`       | 开发者工具                                                          |

没有应用菜单栏，按 Alt 不会弹出任何东西。

---

# English

A personal desktop DAW, organised the way FL Studio is: Channel Rack / Piano Roll / Pattern / Playlist.

Out of scope: live MIDI performance, VST hosting, auto-update, cloud sync, multi-user.

## Requirements

- **Node.js `^20.19.0` or `>=22.12.0`** (what electron-vite 5 requires)
- Windows / macOS / Linux

## Running it

```bash
npm install
npm run dev
```

- `npm install` downloads the Electron binary on first run (a few hundred MB) — give it a minute. It then runs `electron-builder install-app-deps` automatically.
- If your network needs a proxy, set `proxy` / `https-proxy` in `.npmrc`. Without the proxy running, `install` fails with `ECONNREFUSED` — that is the proxy, not the package.
- `npm run dev` hot-reloads: edits under `renderer` apply on save, edits under `main` / `preload` restart the app.

Other commands:

| Command             | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `npm run build`     | Typecheck, then compile to `out/`. Does **not** produce an installer |
| `npm start`         | Run what is already in `out/` (build first)                          |
| `npm run typecheck` | Typecheck both tsconfigs, node and web                               |
| `npm run lint`      | ESLint                                                               |
| `npm run format`    | Prettier, writing in place                                           |

## Packaging

```bash
npm run build:unpack   # -> dist/win-unpacked/   no installer, run the exe in there
npm run build:win      # -> dist/my-daw-1.0.0-setup.exe   NSIS installer
npm run build:mac      # macOS only
npm run build:linux
```

Artefacts land in `dist/`. `out/` is electron-vite's compiled output — an intermediate, not a deliverable. The packaged app does not include `src/`.

Worth knowing:

- **The first package downloads extra binaries from GitHub** (`winCodeSign`, `nsis`). Behind a proxy, this is the step that needs it. They are cached in `%LOCALAPPDATA%\electron-builder\Cache` and not fetched again.
- **`build:mac` and `build:linux` do not run the typecheck** — only `build:win` does, because the `build` script carries it and those two call `electron-vite build` directly. That asymmetry comes from the scaffold. Run `npm run build` once by hand before packaging for another platform, or type errors slip through.
- `publish` in `electron-builder.yml` points at `example.com/auto-updates`. This project has no auto-update; it can be deleted.
- To check the packaged result without installing anything, use `build:unpack` — it is much faster.

## Notes

### Samples

There are two sets, stacked in the 采样库 (sample library) window.

**The built-in library** (Drums / Guitar / Piano, 17 sounds) is synthesised in code. Clicking one builds a channel on the rack and auditions it — no file involved. Drums starts expanded, the rest start collapsed.

**Your own folder**: click 选择采样目录 and point it at a folder of audio files.

- One level deep only. **Subfolder names become the categories**; files sitting at the top level are filed under （根目录）/ "(root)".
- Recognised extensions: `wav` `mp3` `ogg` `oga` `opus` `flac` `m4a` `aac` `webm`.
- The scan lists directories only — **nothing is decoded**. A file is read when you click it, so pointing at a folder of thousands costs nothing at startup.
- Drop a new file in and click 刷新 / Refresh.
- The folder path is stored in `%APPDATA%\my-daw\settings.json` (macOS: `~/Library/Application Support/my-daw/`), **not in the project file**. Changing folders does not affect existing projects.
- **Use one-shots, not loops.** This is a sampler, not a slicer — a loop dropped on a note plays its whole length.
- Where to get material: Freesound (filter to CC0), MusicRadar SampleRadar, `pumodi/open-samples` on GitHub. Note that **CC0 is not all of CC**: CC-BY needs attribution, CC-NC forbids commercial use.

### Exporting

导出音频 in the toolbar. The range is **always the whole Song** — there is no "current Pattern only".

Options: format (WAV / MP3), sample rate (44100 / 48000), WAV bit depth (16 / 24-bit) or MP3 bit rate (128–320 kbps), tempo (BPM), loudness (dB), tail (seconds), and peak normalisation to −1 dBFS.

How the render works:

- It uses **the same timeline flattening the transport uses**. What you hear in the app is what gets written — not two code paths that have to be kept in step by hand.
- Every channel's current volume, pan, mute and solo is applied, along with the Playlist tracks' mute / solo.
- **Only piano-roll notes are rendered.** In Song mode the step grid never sounds, so the export does not include it either. That is the playback behaviour, not a choice the exporter makes.
- Duration = the Song's total length plus the tail.

Things that bite:

- **Put Patterns on the Playlist first** (in the Song window). With no clips on the timeline the export button is disabled.
- The save dialog comes up **before** the render. Rendering is the slow part; asking for a path at the end would mean a cancelled dialog wasted the whole render.
- **The dialog cannot be closed mid-render**, Esc included.
- Changing 速度 (tempo) is a **re-layout, not time-stretching**: clips are re-measured against the new BPM and the samples keep their pitch. It sounds like the whole song getting faster or slower. The project's own BPM is untouched.
- Loudness `0 dB` is the original level. Peak normalisation scales the whole mix by one factor — relative balance between channels is unchanged; the loudest point just moves to −1 dBFS.

### Files

- Projects are `.mydaw`, and the contents are JSON.
- **A project stores sample file paths, not audio data.** The project file stays small, but if a sample is moved or deleted, that row reads 采样缺失 / "sample missing" when you reopen — the channel and its position survive, and putting the file back reconnects it. The path is not erased, and saving again does not lose it.
- Channels with a missing sample are **left out of the export** rather than rendered as silence.
- `Ctrl+S` saves, `Ctrl+O` opens, `Ctrl+Z` undoes. The 文件 menu has 新建 / 打开… / 保存 / 另存为…, with the project name beside the button and a `•` when there are unsaved changes.
- 新建 and 打开 raise a **native** system dialog asking whether to discard unsaved work. It is drawn by the main process rather than in the window, so that the click that opened 新建 cannot also dismiss the question it raised.
- **Undo is snapshot-based and holds the project only.** Dragging the playback start in the Song window is **not undoable and not a change**, which is why moving just the playhead will not prompt you to save.
- Exporting does **not** save the project.

## Keyboard

| Key          | Action                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `Space`      | Play / stop. Plays the open piano roll if there is one, the Song in song mode, the step loop otherwise |
| `Ctrl+Z`     | Undo                                                                                                   |
| `Ctrl+S`     | Save                                                                                                   |
| `Ctrl+O`     | Open                                                                                                   |
| `Ctrl+wheel` | Horizontal zoom in the piano roll and the Song window                                                  |
| `Ctrl+A`     | Select all notes (piano roll)                                                                          |
| `Ctrl+drag`  | Copy clips (Song window)                                                                               |
| `F12`        | DevTools                                                                                               |

There is no application menu bar; pressing Alt brings up nothing.
