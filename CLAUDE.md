# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

This repo is the **unmodified [`electron-vite`](https://electron-vite.org) React + TypeScript template**. Despite the package name `my-daw`, there is no audio/DAW code yet — `App.tsx` still renders the scaffold's welcome screen. Treat the architecture below as the starting point to build on, not as existing product structure.

There is **no test framework installed** (no vitest/jest, no `test` script). Do not assume a test command exists; if you add tests, also add the runner and the script.

## Commands

```bash
npm run dev              # electron-vite dev — HMR for renderer, restarts main on change
npm run build            # typecheck (node + web) then electron-vite build -> out/
npm run start            # electron-vite preview — run the built output
npm run lint             # eslint --cache .
npm run format           # prettier --write .
npm run typecheck        # both typecheck:node and typecheck:web
npm run typecheck:node   # tsc --noEmit -p tsconfig.node.json --composite false
npm run typecheck:web    # tsc --noEmit -p tsconfig.web.json --composite false

npm run build:unpack     # build + electron-builder --dir (unpacked, fastest packaging check)
npm run build:win        # build + electron-builder --win
npm run build:mac        # electron-vite build + electron-builder --mac
npm run build:linux      # electron-vite build + electron-builder --linux
```

Note the asymmetry: `build:win` runs through `npm run build` (so it typechecks first), but **`build:mac` and `build:linux` call `electron-vite build` directly and skip typechecking**. Run `npm run typecheck` explicitly before those two.

Debugging: `.vscode/launch.json` provides "Debug Main Process" (launches electron-vite with `--sourcemap` and `REMOTE_DEBUGGING_PORT=9222`) and "Debug Renderer Process" (Chrome attach on port 9222), combined as "Debug All". In dev, F12 opens DevTools.

Packaging config lives in [electron-builder.yml](electron-builder.yml). It currently publishes to a placeholder (`https://example.com/auto-updates`) and uses `appId: com.electron.app` — both need real values before shipping.

## Architecture

Three processes, three separate build targets, configured in [electron.vite.config.ts](electron.vite.config.ts). `main` and `preload` use their defaults; only `renderer` customizes anything (the React plugin and the `@renderer` alias).

| Process | Source | tsconfig | Output |
| --- | --- | --- | --- |
| main | [src/main/](src/main/) | `tsconfig.node.json` | `out/main/` |
| preload | [src/preload/](src/preload/) | `tsconfig.node.json` | `out/preload/` |
| renderer | [src/renderer/src/](src/renderer/src/) | `tsconfig.web.json` | `out/renderer/` |

`package.json` `main` points at `out/main/index.js` — **build output is `out/`, and the entry is the compiled JS, not the TypeScript source.**

### TypeScript is split by process

The root [tsconfig.json](tsconfig.json) has no files of its own — it only references the two project configs, which use different `@electron-toolkit/tsconfig` bases (`tsconfig.node.json` vs `tsconfig.web.json`). This means:

- Renderer code cannot import Node builtins or Electron main-process modules; it will fail `typecheck:web`.
- Main/preload code cannot use DOM types or JSX.
- `@renderer/*` maps to `src/renderer/src/*` — the alias is declared in **both** [electron.vite.config.ts](electron.vite.config.ts) (for bundling) and [tsconfig.web.json](tsconfig.web.json) (for typechecking). Adding an alias means editing both.

### Inter-process communication

The window is created with `sandbox: false` and a preload script at `../preload/index.js` ([src/main/index.ts](src/main/index.ts)).

The bridge pattern, in [src/preload/index.ts](src/preload/index.ts): `@electron-toolkit/preload`'s `electronAPI` is exposed as `window.electron`, and a local `api` object (currently empty) as `window.api`. Both are exposed via `contextBridge` when context isolation is on, with a `window`-assignment fallback otherwise.

Types for both globals are declared in [src/preload/index.d.ts](src/preload/index.d.ts) — this file is included by `tsconfig.web.json` so the renderer can see them. **When you add methods to the preload `api` object, update `index.d.ts` too**, or the renderer will not typecheck against them.

The IPC example is wired end to end already: [App.tsx](src/renderer/src/App.tsx) calls `window.electron.ipcRenderer.send('ping')` and `ipcMain.on('ping', ...)` logs `pong` in the main process. Follow that shape for new channels — add a `ipcMain.on`/`ipcMain.handle` in main, expose a wrapper on the preload `api`, declare it in `index.d.ts`.

### Renderer entry

[src/renderer/index.html](src/renderer/index.html) → [src/renderer/src/main.tsx](src/renderer/src/main.tsx) → `App.tsx`. Styles are plain CSS imported as side effects from [src/renderer/src/assets/](src/renderer/src/assets/) (`base.css`, `main.css`) — no CSS framework is set up.

## Conventions

Prettier config ([.prettierrc.yaml](.prettierrc.yaml)): **single quotes, no semicolons**, 100-char width, no trailing commas. Run `npm run format` rather than hand-matching. ESLint ([eslint.config.mjs](eslint.config.mjs)) layers `@electron-toolkit` TS rules with the React, react-hooks, and react-refresh (Vite) rules, and ignores `node_modules`, `dist`, `out`.

`.editorconfig` mandates LF line endings and UTF-8. Note that `build/` holds packaging assets (icons, entitlements), not build output.
## 音频项目专属约束

### 时间与调度
- 所有时间单位统一用**秒**（AudioContext.currentTime），禁止混用 tick 和秒
- 音频调度禁止用 setInterval / setTimeout，统一用 Web Audio 调度或 Tone.js Transport
- 播放时钟以 AudioContext 为准，不要依赖 requestAnimationFrame 计时

### 进程边界
- 主进程（src/main）：只做文件读写、窗口管理、IPC
- 预加载（src/preload）：只暴露 IPC 接口，不做业务逻辑
- 渲染进程（src/renderer）：所有音频逻辑、UI、状态管理都放这里

### 音频处理
- 音频解码统一用 AudioContext.decodeAudioData
- 播放用 AudioBufferSourceNode 或 Tone.Player
- 不做实时 MIDI 监听，避免延迟问题

### 协作规则
- 每次只改一个模块，不要顺手做别的功能
- 改动前说明会影响哪些文件
- 完成后给出手动测试步骤
- 有歧义先问，不要自己猜

## 项目定位（重要）

- 这是一个**个人自用**的网页/桌面 DAW，目标不是做成商业产品，而是**尽可能接近 FL Studio 的工作流**。
- 优先实现 FL Studio 的核心交互：
  - Channel Rack（通道机架）：管理采样、音色通道
  - Playlist（播放列表）：自由编排 Pattern
  - Piano Roll（钢琴卷帘）：编曲核心
  - Pattern / Song 双模式
- **不做实时演奏监听**，避免延迟问题，播放/导出优先。
- 不做 VST 托管、不做自动更新、不做云同步、不做多用户。这些会显著增加复杂度，与自用目标无关。
- 代码可读性 > 性能优化 > 架构完美。先能跑、能出声、能用，再谈重构。
- 每次新增功能前，先问自己：这能让它更像 FL Studio 吗？如果是通用 DAW 的“加分项”但不是 FL 的核心，先不做。