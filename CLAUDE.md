# CLAUDE.md

## 项目定位

个人自用的桌面 DAW，目标是尽可能接近 FL Studio 的工作流。
核心模块：Channel Rack / Piano Roll / Pattern / Playlist。
不做：实时 MIDI 演奏、VST 托管、自动更新、云同步、多用户。

## 命令

npm run dev # 开发
npm run build # 构建（含 typecheck）
npm run lint # 检查
npm run typecheck # 类型检查

## 架构

- main (src/main)：只做文件读写、窗口管理、IPC
- preload (src/preload)：只暴露 IPC 接口
- renderer (src/renderer/src)：所有音频逻辑、UI、状态管理
- 构建输出在 out/，入口是编译后的 JS

TypeScript 按进程拆分：

- renderer 不能用 Node/Electron 主进程模块
- main/preload 不能用 DOM
- @renderer/* 别名同时配置在 electron.vite.config.ts 和 tsconfig.web.json
- 新增 preload API 必须同步更新 src/preload/index.d.ts

## 代码约定

- Prettier：单引号、无分号、100 字符宽、无尾逗号
- 用 npm run format，不要手写对齐

## 音频约束

- 时间单位统一用秒（AudioContext.currentTime），禁止混 tick 和秒
- 禁止用 setInterval / setTimeout 驱动播放
- 播放时钟以 AudioContext 为准，不用 rAF 计时
- 解码统一用 decodeAudioData
- 播放用 AudioBufferSourceNode（暂时不引入 Tone.js）

## 协作规则

- 每次只做一个模块（我告诉你的应该改的），不顺手做别的
- 改动前说明会影响哪些文件
- 完成后只给手动测试步骤，由我本人测
- 不要主动运行测试脚本、不要生成临时 .cjs / .mjs 文件
- 有歧义先问，不要自己猜
