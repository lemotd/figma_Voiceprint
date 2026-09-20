# Voiceprint · 声纹生成 Figma 插件

在画布上随机生成一段声纹图：一排关于水平中线对称的圆角竖条，中间穿插几个高振幅波峰，形似音频波形。

## 功能

- 参数化生成：条数、条宽、间距、最大高度、波峰数量、颜色、随机种子
- **面板内实时预览**：参数一动，预览即刻重绘，无需生成到画布再看
- **画板尺寸自适应**：选中一个 Frame 后开启"跟随宽高"，条数按 `floor((width + gap) / (barWidth + gap))` 自动计算，最大高度直接取节点高度
- 种子可复现：同一 seed 产出同一段波形，方便复用或分享

## 目录

```
figma-plugin-voiceprint/
├── manifest.json   # 插件配置
├── code.js         # 主进程：算法 + 画布生成
├── ui.html         # 参数面板 UI
└── README.md
```

## 参数

| 参数 | 范围 | 默认 | 说明 |
| --- | --- | --- | --- |
| 条数 | 4 – 500 | 60 | 声纹里竖条的数量 |
| 条宽 | 1 – 40 px | 4 | 每条的宽度；也决定圆角半径（= 宽 / 2） |
| 间距 | 0 – 40 px | 4 | 相邻两条之间的空隙 |
| 最大高度 | 20 – 1000 px | 200 | 波峰位置对应的高度上限 |
| 波峰数量 | 0 – 20 | 5 | 高振幅"节奏点"个数；0 则输出纯低噪声 |
| 颜色 | HEX | `#7B8CFF` | 竖条填充色 |
| 随机种子 | uint32 / 空 | 空 | 相同种子产出同一段声纹；留空则每次随机 |

## 波形生成算法

在 `code.js` 的 `buildAmplitudes(count, peaks, rng)` 里：

1. **平滑基础噪声**：每 `count/24` 条采一个"控制点"随机值，相邻控制点用 smoothstep 插值，得到连续起伏的底噪 `0.05 ~ 0.18`。相邻条振幅接近，去掉逐条独立随机的锯齿感。
2. **随机布峰**：在避开两端 5% 边缘处随机挑 `peaks` 个位置。
3. **峰高偏低分布**：峰值 `0.5 + rng² × 0.45`（约 `0.5 ~ 0.95`），平方分布让高峰罕见——大多数峰是"中等"，少数才顶到接近上限。
4. **每峰独立宽度**：`σ` 在基准 `count / (peaks × 8)` 上再乘 `0.6 ~ 1.5` 的随机系数，产生窄峰宽峰之间的个体差异。
5. **Screen blend 融合**：`v = v + c × (1 - v)`，代替 `max` 硬合并。峰边缘与底噪平滑过渡，多峰叠加也永远不会超过 1。
6. **映射到高度**：`h = max(barWidth, amp × maxHeight)`，最矮不低于条宽（不然圆角矩形会退化成不可见圆点）。
7. **中线对齐**：`rect.y = (maxHeight - h) / 2`。

随机数用 [mulberry32](https://gist.github.com/tommyettinger/46a3c6ee29a53c1e07f8dc7f7ebc82c9) —— 一个 32-bit 种子的小型 PRNG，同一 seed 输出稳定序列，方便复现。

## 输出结构

生成结果是一个名为 `Voiceprint` 的 Frame，透明填充、不裁剪，内部包含 N 个 `bar` 圆角矩形。

- 想改颜色：直接选中 Frame → 修改填充，或用 Figma 的批量编辑改所有子矩形。
- 想扁平化：右键 Frame → **Flatten**（`⌘E`）合成单个矢量。
- 想导出：右键 → **Export** 成 SVG / PNG。
- 想加背景：给 Frame 设填充色即可。

## 在 Figma 中加载

1. 打开 **Figma 桌面版**。
2. 菜单 **Plugins → Development → Import plugin from manifest…**，选择 `manifest.json`。
3. 任意画布里右键 **Plugins → Development → Voiceprint** 打开面板。
4. 拖动滑块调整参数，预览区会即时更新；点 🎲 换一个种子换一段波形。
5. 确认效果后点 **生成到画布**，会在视口中心产出一个 `Voiceprint` Frame。
6. 调试：**Plugins → Development → Open console** 打开 DevTools。

## 实时预览

UI 面板顶部有一块 canvas，参数变化时用 `requestAnimationFrame` 去抖后重绘。

- 预览与画布生成使用**同一份**振幅算法（`buildAmplitudes` + `mulberry32`），UI 和主进程各存一份，改一处两处都要跟上（`ui.html` 顶部有注释提示）。
- 预览按比例缩放到 canvas 尺寸，任何参数下都能看到完整形状。
- 预览用的 seed 就是最终生成时会发给主进程的 seed，保证「所见即所得」。

## 画板自适应

选中任意有尺寸的节点（Frame、Group、矩形…），面板顶部会显示节点类型 / 宽 × 高，同时启用「跟随宽高」开关。

- 勾选后，条数与最大高度两个字段同时被锁定：
  - 条数由 `barWidth` 和 `gap` 反推：`count = floor((width + gap) / (barWidth + gap))`，至少 4。
  - 最大高度取节点高度，clamp 到 20 – 1000 px。
- 调整条宽或间距时，条数会自动重新计算，预览随之更新。
- 取消选中时开关自动关闭，两个字段一起解锁。
- 生成结果的**位置**目前仍放在视口中心，不会自动嵌入选中 Frame；如需嵌入，把 Voiceprint 拖进去即可。

## 后续可扩展方向

- **对称模式**：目前是"上下同高对称"，可加个开关做"只朝上"或"上下不对称"。
- **导出 SVG 字符串**：主进程用 `frame.exportAsync({ format: 'SVG' })` 拿到 SVG，回传 UI 展示或下载。
- **平滑曲线模式**：把竖条换成 Bezier 曲线路径（`figma.createVector()`），配合 `sin/cos` 组合，模拟连续波形。
- **音频驱动**：UI 里加 `<input type="file" accept="audio/*">`，用 `AudioContext` + `AnalyserNode` 解出真实幅度序列，传给主进程照原样绘制，就变成真声纹可视化。
