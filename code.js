// 主进程：接收 UI 参数，生成一组关于水平中线对称的圆角竖条组成的"声纹"。

figma.showUI(__html__, { width: 320, height: 620 });

figma.ui.onmessage = (msg) => {
  if (msg.type === 'generate') {
    generate(msg);
  } else if (msg.type === 'close') {
    figma.closePlugin();
  }
};

// ---------- 选中节点尺寸推送 ----------
// UI 需要知道当前选中的画板宽度，用于"自适应条数"功能。
// 打开面板时立刻推一次，之后每当选中变化再推。
function pushSelection() {
  const sel = figma.currentPage.selection[0];
  if (sel && 'width' in sel && 'height' in sel) {
    figma.ui.postMessage({
      type: 'selection',
      node: {
        id: sel.id,
        name: sel.name,
        type: sel.type,
        width: Math.round(sel.width),
        height: Math.round(sel.height),
      },
    });
  } else {
    figma.ui.postMessage({ type: 'selection', node: null });
  }
}
pushSelection();
figma.on('selectionchange', pushSelection);

// ---------- 主流程 ----------
function generate(params) {
  const count = clampInt(params.count, 4, 500, 60);
  const barWidth = clampNum(params.barWidth, 1, 40, 4);
  const gap = clampNum(params.gap, 0, 40, 4);
  const maxHeight = clampNum(params.maxHeight, 20, 1000, 200);
  const peaks = clampInt(params.peaks, 0, 20, 5);
  const color = hexToRgb(params.colorHex || '#7B8CFF');
  const seed = Number.isFinite(params.seed)
    ? params.seed >>> 0
    : (Math.random() * 0xffffffff) >>> 0;

  const rng = mulberry32(seed);
  const amps = buildAmplitudes(count, peaks, rng);
  const totalWidth = count * barWidth + Math.max(0, count - 1) * gap;

  // 用 Frame 作容器，透明填充、不裁剪，方便后续整体移动/复制。
  const frame = figma.createFrame();
  frame.name = 'Voiceprint';
  frame.fills = [];
  frame.clipsContent = false;
  frame.resize(totalWidth, maxHeight);

  for (let i = 0; i < count; i++) {
    const h = Math.max(barWidth, amps[i] * maxHeight);
    const rect = figma.createRectangle();
    rect.name = 'bar';
    rect.resize(barWidth, h);
    rect.x = i * (barWidth + gap);
    rect.y = (maxHeight - h) / 2; // 中线对齐
    rect.cornerRadius = barWidth / 2; // 圆角自动 clamp 成药丸/圆点
    rect.fills = [{ type: 'SOLID', color }];
    frame.appendChild(rect);
  }

  // 放到当前视口中心，选中并对焦。
  frame.x = Math.round(figma.viewport.center.x - totalWidth / 2);
  frame.y = Math.round(figma.viewport.center.y - maxHeight / 2);
  figma.currentPage.appendChild(frame);
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);

  figma.ui.postMessage({ type: 'done', seed, count });
}

// ---------- 振幅算法 ----------
// 目标：像真实录音那样有层次的起伏——宏观包络、音节波动、样本级毛刺三者并存。
// 步骤：
//   1) 底噪用三层不同频率的平滑噪声叠加（fBm 风格）：低频当句子级包络，中频当音节起伏，高频加细节。
//      单层平滑噪声太"绵"，多层叠加才拉得开层次。
//   2) 峰的高度用二次偏低分布，避免大多数峰都顶到最高；每个峰独立宽度，产生个体差异。
//   3) 用 screen blend（v + c(1-v)）而不是 max 叠加，峰的边缘与底噪过渡平滑，且不会超过 1。
//   4) 最后每根条乘一个 ±15% 的独立抖动，模拟数字采样的样本级毛刺，让相邻条不再"顺滑"。
function buildAmplitudes(count, peaks, rng) {
  const amps = new Array(count);

  // 1) 多频段平滑噪声
  const layers = [
    { stride: Math.max(6, Math.floor(count / 8)), weight: 0.55 },
    { stride: Math.max(3, Math.floor(count / 18)), weight: 0.3 },
    { stride: Math.max(2, Math.floor(count / 40)), weight: 0.15 },
  ];
  const smoothstep = (t) => t * t * (3 - 2 * t);
  const layerKnots = layers.map(({ stride }) => {
    const kc = Math.ceil(count / stride) + 2;
    const arr = new Array(kc);
    for (let i = 0; i < kc; i++) arr[i] = rng();
    return arr;
  });
  const sampleLayer = (knots, stride, i) => {
    const t = i / stride;
    const k0 = Math.floor(t);
    const f = t - k0;
    return knots[k0] * (1 - smoothstep(f)) + knots[k0 + 1] * smoothstep(f);
  };
  for (let i = 0; i < count; i++) {
    let v = 0;
    for (let j = 0; j < layers.length; j++) {
      v += sampleLayer(layerKnots[j], layers[j].stride, i) * layers[j].weight;
    }
    amps[i] = 0.06 + v * 0.29; // 底噪 0.06 ~ 0.35
  }

  // 2) 峰位、峰高、峰宽都独立随机
  if (peaks > 0) {
    const margin = Math.max(1, Math.floor(count * 0.05));
    const baseSigma = Math.max(1.4, count / (peaks * 8));
    const positions = [];
    for (let k = 0; k < peaks; k++) {
      const idx = margin + Math.floor(rng() * Math.max(1, count - margin * 2));
      // pow(rng, 2) 让高峰罕见：大部分峰落在 0.5 ~ 0.75，少数才接近 0.95。
      const amp = 0.5 + Math.pow(rng(), 2) * 0.45;
      const sigma = baseSigma * (0.6 + rng() * 0.9);
      positions.push({ idx, amp, sigma });
    }

    // 3) Screen blend 叠加
    for (let i = 0; i < count; i++) {
      let v = amps[i];
      for (const p of positions) {
        const d = i - p.idx;
        const c = p.amp * Math.exp(-(d * d) / (2 * p.sigma * p.sigma));
        v = v + c * (1 - v);
      }
      amps[i] = v;
    }
  }

  // 4) 每根条独立乘性抖动。±15% 是经验值：太小看不出，太大会破坏包络形状。
  for (let i = 0; i < count; i++) {
    const jitter = 0.85 + rng() * 0.3;
    amps[i] = Math.min(1, amps[i] * jitter);
  }
  return amps;
}

// ---------- 工具 ----------
function hexToRgb(hex) {
  const clean = String(hex).replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return { r: 0.48, g: 0.55, b: 1 };
  return {
    r: parseInt(clean.slice(0, 2), 16) / 255,
    g: parseInt(clean.slice(2, 4), 16) / 255,
    b: parseInt(clean.slice(4, 6), 16) / 255,
  };
}

// mulberry32：小巧的可复现伪随机数生成器，给定 seed 产出稳定序列。
function mulberry32(a) {
  let t = a >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
