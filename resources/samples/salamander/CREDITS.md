# Salamander Grand Piano

这是仓库里唯一一批二进制文件。其余内置音色都是代码合成的（见
`src/renderer/src/audio/library.ts`）。

- **录音**：Alexander Holm，2016
- **乐器**：Yamaha C5 三角钢琴，两支 AKG C414 以 AB 制式架在弦上方约 12 cm
- **许可证**：[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
  —— 允许商用、修改、再分发，条件是保留署名
- **上游**：<https://archive.org/details/SalamanderGrandPianoV3>
- 本目录里的文件取自 <https://tonejs.github.io/audio/salamander/>
  （Tone.js 托管的版本），**未做任何修改**

## 文件名

按小三度一个采样，覆盖 A0–C8 共 30 个音：

```
A0  C1  Ds1  Fs1  A1  C2  Ds2  Fs2  A2  C3
Ds3 Fs3 A3   C4   Ds4 Fs4 A4   C5   Ds5 Fs5
A5  C6  Ds6  Fs6  A6  C7  Ds7  Fs7  A7  C8
```

`Ds` 是升 D，`Fs` 是升 F（不是 `D#` / `F#`，沿用上游的写法）。

## 署名（用于界面或文档）

> Salamander Grand Piano by Alexander Holm, licensed under CC BY 3.0.
> https://creativecommons.org/licenses/by/3.0/
