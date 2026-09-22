// 主进程：接收 UI 参数，生成一组关于水平中线对称的圆角竖条组成的"声纹"。

figma.showUI(__html__, { width: 320, height: 620 });

// ---------- 参数持久化 ----------
// 用 figma.clientStorage 跨会话记住上次生成时用的参数，含"跟随宽高"开关；seed 不存。
// clientStorage 是异步 API，UI 打开时先渲染默认值，参数到达后再回填，会有一次很短的跳变。
const STORAGE_KEY = 'voiceprint:lastParams';

figma.clientStorage
  .getAsync(STORAGE_KEY)
  .then((saved) => {
    if (saved && typeof saved === 'object') {
      figma.ui.postMessage({ type: 'restore', params: saved });
    }
  })
  .catch(() => {});

figma.ui.onmessage = (msg) => {
  if (msg.type === 'pollSelection') {
    // UI 侧定时问一次，作为 nodechange 的兜底。尺寸没变时 pushSelection 内部会跳过，
    // 不会白发消息。
    pushSelection();
    return;
  }
  if (msg.type === 'generate') {
    generate(msg);
    figma.clientStorage
      .setAsync(STORAGE_KEY, {
        count: msg.count,
        barWidth: msg.barWidth,
        gap: msg.gap,
        maxHeight: msg.maxHeight,
        peaks: msg.peaks,
        colorHex: msg.colorHex,
        opacity: msg.opacity,
        // 存成严格布尔：UI 漏传时会是 undefined，写进 storage 会让回填分支的
        // typeof === 'boolean' 判断失效。
        followSize: msg.followSize === true,
      })
      .catch(() => {});
  }
};

// ---------- 选中节点尺寸推送 ----------
// UI 需要知道当前选中节点的宽高，用于"跟随宽高"功能。
// 只监听 selectionchange 是不够的：用 F 拖出一个新画板时，Figma 在拖动早期就把它
// 设成了选中项，那一刻宽高还是起手的小尺寸；之后一路拖到松手，选中项从没变过，
// selectionchange 不会再触发，面板就永远停在那个初始尺寸上。拖手柄改已有画板同理。
// 所以尺寸变化要单独盯：
//   1. 打开面板时同步推一次，面板开局就有值
//   2. selectionchange —— 换了选中目标
//   3. nodechange —— 选中目标自身尺寸被改（拖动创建、拖手柄 resize、改 W/H 输入框）
//   4. UI 侧低频轮询发来的 pollSelection —— 兜底，防止 nodechange 在某些交互里
//      被合并或整批漏发。轮询定时器放在 UI（iframe 是真正的浏览器环境，setInterval
//      必定可用），主进程沙箱对 timer 的支持在官方文档里说法不一，不依赖它。

// 上次推给 UI 的快照。resize 过程中事件很密，靠它去重，值没变就不发消息。
let lastPushed = null;

function readSelectionSize() {
  try {
    const sel = figma.currentPage.selection[0];
    if (!sel) return null;
    if (!('width' in sel) || !('height' in sel)) return null;
    return {
      id: sel.id,
      name: sel.name,
      type: sel.type,
      width: Math.round(sel.width),
      height: Math.round(sel.height),
    };
  } catch (e) {
    // 节点在读取的瞬间被删掉了，属性访问会抛错，当作没有选中
    return null;
  }
}

function sameSnapshot(a, b) {
  if (a === b) return true; // 含 null === null：无选中状态不必重复推
  if (!a || !b) return false;
  return a.id === b.id && a.width === b.width && a.height === b.height;
}

function pushSelection(force) {
  const node = readSelectionSize();
  if (!force && sameSnapshot(node, lastPushed)) return;
  lastPushed = node;
  figma.ui.postMessage({ type: 'selection', node });
}

// nodechange 是 page 级事件，在 documentAccess: dynamic-page 下可直接用当前页注册，
// 不像 figma.on('documentchange') 那样要先 loadAllPagesAsync 把整个文档拉起来。
// 刻意不按变化里的 node id 过滤：容器（GROUP / auto layout frame）的尺寸可能是被
// 子节点撑开的，那种变化列表里并没有容器自己。pushSelection 内部已经去重，
// 每次重读一遍宽高的成本可以忽略。
function onNodeChange() {
  pushSelection();
}

// currentPage 换了要把监听搬过去，否则新页面上的 resize 收不到。
let boundPage = null;
function bindNodeChange() {
  if (boundPage === figma.currentPage) return;
  if (boundPage) {
    try {
      boundPage.off('nodechange', onNodeChange);
    } catch (e) {}
  }
  boundPage = figma.currentPage;
  try {
    boundPage.on('nodechange', onNodeChange);
  } catch (e) {
    boundPage = null; // 环境不支持 nodechange，退回纯轮询
  }
}

pushSelection(true);
bindNodeChange();
figma.on('selectionchange', () => pushSelection());
figma.on('currentpagechange', () => {
  bindNodeChange();
  pushSelection();
});

// ---------- 放置目标 ----------
// 能直接收纳新子节点的容器类型。
// 刻意排除两类：INSTANCE 内部禁止插入子节点；COMPONENT_SET 只接受 COMPONENT 子节点。
// 选中它们时会继续往上找父级。
const CONTAINER_TYPES = ['FRAME', 'COMPONENT', 'GROUP', 'SECTION'];
// 这些容器建立自己的坐标系，子节点 x/y 相对容器左上角；
// GROUP / SECTION / PAGE 不建立坐标系，子节点 x/y 仍在容器所处的坐标系里。
const LOCAL_COORD_TYPES = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'];

// 从选中项出发向上找第一个可收纳的容器：
// 选中画板 → 画板本身；选中画板里的某个图层 → 它所在的画板。
// 没选中、或选中项直接躺在页面根级时返回 null，走"放到视口中心"的老路径。
function resolveParent() {
  let node = figma.currentPage.selection[0];
  while (node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
    if (CONTAINER_TYPES.indexOf(node.type) !== -1) return node;
    node = node.parent;
  }
  return null;
}

// ---------- 主流程 ----------
function generate(params) {
  const count = clampInt(params.count, 4, 500, 60);
  const barWidth = clampNum(params.barWidth, 1, 40, 4);
  const gap = clampNum(params.gap, 0, 40, 4);
  const maxHeight = clampNum(params.maxHeight, 20, 1000, 200);
  const peaks = clampInt(params.peaks, 0, 20, 5);
  const color = hexToRgb(params.colorHex || '#8C93B0');
  const opacity = clampNum(params.opacity, 0, 1, 0.4);
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
    rect.fills = [{ type: 'SOLID', color, opacity }];
    frame.appendChild(rect);
  }

  // 有选中容器就放进去并居中，否则放到当前视口中心。
  const parent = resolveParent();
  if (parent) {
    // 先快照父容器几何：GROUP 的 bounding box 会被新子节点撑大，
    // append 之后再读 x/width 算出来的居中位置是错的。
    const box = {
      x: parent.x,
      y: parent.y,
      width: parent.width,
      height: parent.height,
    };
    parent.appendChild(frame);
    // appendChild 之后才设坐标：入栈时 x/y 数值不变，但解释它的坐标系换了，
    // 先设会被重新解释成另一个位置。
    const autoLayout = 'layoutMode' in parent && parent.layoutMode !== 'NONE';
    if (!autoLayout) {
      // auto layout 容器的子节点位置由布局接管，设 x/y 无效，交给 Figma 自己排。
      const local = LOCAL_COORD_TYPES.indexOf(parent.type) !== -1;
      const ox = local ? 0 : box.x;
      const oy = local ? 0 : box.y;
      frame.x = Math.round(ox + (box.width - totalWidth) / 2);
      frame.y = Math.round(oy + (box.height - maxHeight) / 2);
    }
    // 不动视口：用户刚选中这个容器，通常就在眼前，强行缩放到一根细长条反而打断操作。
  } else {
    frame.x = Math.round(figma.viewport.center.x - totalWidth / 2);
    frame.y = Math.round(figma.viewport.center.y - maxHeight / 2);
    figma.currentPage.appendChild(frame);
    figma.viewport.scrollAndZoomIntoView([frame]);
  }
  figma.currentPage.selection = [frame];

  // 回传 seed，让面板的预览种子和本次生成结果保持一致。
  figma.ui.postMessage({ type: 'done', seed });
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
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    // #8C93B0 fallback
    return { r: 0.5490196, g: 0.5764706, b: 0.6901961 };
  }
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
