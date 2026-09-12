/*!
 * core.js — ステンドグラスのロジック。
 *
 * ここには DOM を触るコードを置かない。だから node だけでテストできる
 * (`npm test`)。枠の割り方・外形・切り抜きといった「正しさが効く」所を
 * まとめてある。描画・音・操作は index.html 側。
 *
 * ブラウザでは <script> で読み込むと window.Core になり、
 * node からは require() できる。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.Core = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ============================================================
     色:宝石の10系統
     ============================================================ */
  const COLOR_FAMILIES = [
    { name: "紅",   shades: ["#c1123a", "#e33d5a", "#8f0f2e", "#ff6b7a"] },
    { name: "橙",   shades: ["#e06520", "#ff8a3d", "#b54a12", "#ffa763"] },
    { name: "金",   shades: ["#e6a417", "#ffc94d", "#b47a0c", "#ffe08a"] },
    { name: "若草", shades: ["#7ab648", "#9ed46a", "#5a8f2e", "#c0e896"] },
    { name: "翠",   shades: ["#0f9d58", "#28c76f", "#0a6e3d", "#66e0a3"] },
    { name: "浅葱", shades: ["#158fa8", "#3ab8cf", "#0d6a80", "#7dd8e8"] },
    { name: "瑠璃", shades: ["#1440c8", "#2a6cf0", "#0d2a8f", "#5aa0ff"] },
    { name: "菫",   shades: ["#6a3fb5", "#8f63d6", "#4a2585", "#b394e8"] },
    { name: "桃",   shades: ["#d4548a", "#ee7fae", "#a83866", "#ffa8cc"] },
    { name: "乳白", shades: ["#cfd9e8", "#e8eef5", "#b8c6d8", "#dfe4ec"] },
  ];

  /* ============================================================
     幾何ユーティリティ
     ============================================================ */
  function rectCell(u0, v0, u1, v1) {
    return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
  }

  /* 長方形を「菱形+四隅の三角」の5枚に割る(大正ガラスの定番) */
  function diamondSplit(u0, v0, u1, v1) {
    const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
    return [
      [[mu, v0], [u1, mv], [mu, v1], [u0, mv]],
      [[u0, v0], [mu, v0], [u0, mv]],
      [[mu, v0], [u1, v0], [u1, mv]],
      [[u1, mv], [u1, v1], [mu, v1]],
      [[u0, mv], [mu, v1], [u0, v1]],
    ];
  }

  function gridCells(cols, rows, u0 = 0, v0 = 0, u1 = 1, v1 = 1) {
    const cells = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        cells.push(rectCell(
          u0 + (u1 - u0) * i / cols,       v0 + (v1 - v0) * j / rows,
          u0 + (u1 - u0) * (i + 1) / cols, v0 + (v1 - v0) * (j + 1) / rows
        ));
      }
    }
    return cells;
  }

  function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;   /* 符号つき */
  }

  /* ポリゴンを凸多角形で切り抜く(Sutherland-Hodgman法)。
     窓の外形(すべて凸)でセルを切るのに使う */
  function clipConvex(subject, clip) {
    const sign = polyArea(clip) > 0 ? 1 : -1;
    let out = subject;
    for (let e = 0; e < clip.length; e++) {
      const a = clip[e], b = clip[(e + 1) % clip.length];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const inside = p => sign * (ex * (p[1] - a[1]) - ey * (p[0] - a[0])) >= -1e-9;
      const inp = out; out = [];
      for (let i = 0; i < inp.length; i++) {
        const p = inp[i], q = inp[(i + 1) % inp.length];
        const pin = inside(p), qin = inside(q);
        if (pin) out.push(p);
        if (pin !== qin) {
          /* 辺 p-q と切断線 a-b の交点 */
          const dx = q[0] - p[0], dy = q[1] - p[1];
          const denom = ex * dy - ey * dx;
          if (Math.abs(denom) > 1e-12) {
            const t = (ex * (a[1] - p[1]) - ey * (a[0] - p[0])) / denom;
            out.push([p[0] + dx * t, p[1] + dy * t]);
          }
        }
      }
      if (out.length === 0) return null;
    }
    return Math.abs(polyArea(out)) < 0.0008 ? null : out;
  }

  /* 点がポリゴンの中にあるか(交差回数で判定)。
     タップした指の位置から、どのセルかを決めるのに使う */
  function pointInPoly(u, v, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > v) !== (yj > v) &&
          u < (xj - xi) * (v - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  const UNIT_RECT = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const clipToUnit = poly => clipConvex(poly, UNIT_RECT);

  /* ============================================================
     押せないかけらを、隣の押せるセルに預ける
     ------------------------------------------------------------
     割る側は最小サイズを守っているが、そのあと窓の外形で切り抜くと、
     ふちに指では押せない細いかけらが残る(実測 8px)。これが 1 枚でも
     混ざると、最後までガラスが嵌まらず鐘が鳴らない。
     そこで、押せない大きさのかけらは、いちばん近い押せるセルの「連れ」に
     しておき、そのセルと一緒に嵌まるようにする。
     こうすれば、どのかけらも必ず誰かの指の下に入る。
     ============================================================ */
  /* 指で押せる最小の大きさ(px)。いちばん細かい vhard の下限が 19px なので、
     これを下回るのは切り抜きで生まれたかけらだけ */
  const TAP_MIN_PX = 18;

  /* @returns {number[]} 各セルの持ち主。自分が押せるなら自分の番号 */
  function attachSlivers(cells, panelW, panelH, minPx = TAP_MIN_PX) {
    const center = cells.map((poly) => {
      let cx = 0, cy = 0;
      for (const p of poly) { cx += p[0]; cy += p[1]; }
      return [cx / poly.length * panelW, cy / poly.length * panelH];
    });

    const host = new Array(cells.length).fill(-1);
    const tappable = [];
    for (let i = 0; i < cells.length; i++) {
      const xs = cells[i].map(p => p[0]), ys = cells[i].map(p => p[1]);
      const w = (Math.max(...xs) - Math.min(...xs)) * panelW;
      const h = (Math.max(...ys) - Math.min(...ys)) * panelH;
      if (Math.min(w, h) >= minPx) { host[i] = i; tappable.push(i); }
    }
    /* 押せるセルが 1 枚も無い(ありえないほど小さい画面)なら、そのまま返す */
    if (tappable.length === 0) return cells.map((_, i) => i);

    for (let i = 0; i < cells.length; i++) {
      if (host[i] !== -1) continue;
      let best = tappable[0], bestD = Infinity;
      for (const j of tappable) {
        const dx = center[i][0] - center[j][0], dy = center[i][1] - center[j][1];
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = j; }
      }
      host[i] = best;
    }
    return host;
  }

  /* ============================================================
     窓の外形 5種(単位座標のポリゴン。縦横比は外形ごとに違う)
     ============================================================ */
  const WINDOW_SHAPES = [
    { key: "rect", name: "Tall Window", ratio: 0.62,
      poly() { return UNIT_RECT; } },

    { key: "square", name: "Square Window", ratio: 1.0,
      poly() { return UNIT_RECT; } },

    { key: "round", name: "Arched Window", ratio: 0.60,
      poly() {
        /* 上が半円のロマネスク窓。画面上で真円弧になるよう縦横比で補正 */
        const r = this.ratio;
        const a = 0.5 * r;               /* 半円の付け根の高さ */
        const pts = [[0, 1], [0, a]];
        for (let i = 0; i <= 16; i++) {
          const th = Math.PI - Math.PI * i / 16;
          pts.push([0.5 + 0.5 * Math.cos(th), a - 0.5 * r * Math.sin(th)]);
        }
        pts.push([1, 1]);
        return pts;
      } },

    { key: "gothic", name: "Gothic Window", ratio: 0.58,
      poly() {
        /* 上が尖るゴシック窓。左右の大きな弧が頂点で出会う */
        const r = this.ratio;
        const s = Math.sqrt(3) / 2 * r;  /* 弧の付け根の高さ(等辺アーチ) */
        const pts = [[0, 1], [0, s]];
        /* 左の弧:中心(1, s)、半径=幅ぶん */
        for (let i = 1; i <= 10; i++) {
          const th = Math.PI + (Math.PI / 3) * i / 10;
          pts.push([1 + Math.cos(th), s + Math.sin(th) * r]);
        }
        /* 右の弧:左の鏡映を逆順で */
        for (let i = 10; i >= 1; i--) {
          const th = Math.PI + (Math.PI / 3) * i / 10;
          pts.push([-Math.cos(th), s + Math.sin(th) * r]);
        }
        pts.push([1, s], [1, 1]);
        return pts;
      } },

    { key: "circle", name: "Rose Window", ratio: 1.0,
      poly() {
        const pts = [];
        for (let i = 0; i < 28; i++) {
          const th = Math.PI * 2 * i / 28;
          pts.push([0.5 + 0.5 * Math.cos(th), 0.5 + 0.5 * Math.sin(th)]);
        }
        return pts;
      } },
  ];

  /* ============================================================
     手作りの幾何学枠 10種(外形は縦長で固定)
     ============================================================ */
  const HANDMADE = [

    { name: "Checker", build() {
        return gridCells(4, 7);
      } },

    { name: "Grand Diamond", build() {
        const b = 0.13, cells = [];
        cells.push(rectCell(0, 0, b, b), rectCell(1 - b, 0, 1, b),
                   rectCell(0, 1 - b, b, 1), rectCell(1 - b, 1 - b, 1, 1));
        cells.push(rectCell(b, 0, 0.5, b), rectCell(0.5, 0, 1 - b, b));
        cells.push(rectCell(b, 1 - b, 0.5, 1), rectCell(0.5, 1 - b, 1 - b, 1));
        cells.push(rectCell(0, b, b, 0.5), rectCell(0, 0.5, b, 1 - b));
        cells.push(rectCell(1 - b, b, 1, 0.5), rectCell(1 - b, 0.5, 1, 1 - b));
        cells.push(...diamondSplit(b, b, 1 - b, 1 - b));
        return cells;
      } },

    { name: "Three Diamonds", build() {
        const s = 0.16, cells = [];
        for (let j = 0; j < 3; j++) {
          cells.push(...diamondSplit(s, j / 3, 1 - s, (j + 1) / 3));
        }
        for (let j = 0; j < 4; j++) {
          cells.push(rectCell(0, j / 4, s, (j + 1) / 4));
          cells.push(rectCell(1 - s, j / 4, 1, (j + 1) / 4));
        }
        return cells;
      } },

    { name: "Sunburst", build() {
        const cells = [];
        const ox = 0.5, oy = 1.0;
        const N = 6;
        const bands = [0, 0.5, 0.95, 2.2];
        const AR = 0.62;
        const pt = (a, r) => [ox + Math.cos(a) * r, oy + Math.sin(a) * r * AR];
        for (let k = 0; k < N; k++) {
          const a0 = Math.PI + Math.PI * k / N;
          const a1 = Math.PI + Math.PI * (k + 1) / N;
          for (let bi = 0; bi < bands.length - 1; bi++) {
            const r0 = bands[bi], r1 = bands[bi + 1];
            const poly = [];
            for (let i = 0; i <= 3; i++) poly.push(pt(a0 + (a1 - a0) * i / 3, r1));
            if (r0 === 0) poly.push([ox, oy]);
            else for (let i = 3; i >= 0; i--) poly.push(pt(a0 + (a1 - a0) * i / 3, r0));
            const clipped = clipToUnit(poly);
            if (clipped) cells.push(clipped);
          }
        }
        return cells;
      } },

    { name: "Columns", build() {
        const cols = 5, cells = [];
        for (let i = 0; i < cols; i++) {
          const cuts = i % 2 === 0 ? [0, 0.3, 0.7, 1] : [0, 0.5, 1];
          for (let j = 0; j < cuts.length - 1; j++) {
            cells.push(rectCell(i / cols, cuts[j], (i + 1) / cols, cuts[j + 1]));
          }
        }
        return cells;
      } },

    { name: "Brickwork", build() {
        const rows = 7, cols = 3, cells = [];
        for (let j = 0; j < rows; j++) {
          const off = (j % 2) * 0.5 / cols;
          if (off > 0) cells.push(rectCell(0, j / rows, off, (j + 1) / rows));
          for (let i = 0; i < cols; i++) {
            const u0 = off + i / cols;
            if (u0 >= 1) break;
            cells.push(rectCell(u0, j / rows, Math.min(u0 + 1 / cols, 1), (j + 1) / rows));
          }
        }
        return cells;
      } },

    { name: "Door Panel", build() {
        const b = 0.15, cells = [];
        cells.push(rectCell(0, 0, b, b), rectCell(1 - b, 0, 1, b),
                   rectCell(0, 1 - b, b, 1), rectCell(1 - b, 1 - b, 1, 1));
        cells.push(rectCell(b, 0, 1 - b, b), rectCell(b, 1 - b, 1 - b, 1));
        cells.push(rectCell(0, b, b, 1 - b), rectCell(1 - b, b, 1, 1 - b));
        cells.push(rectCell(b, b, 0.5, 0.45), rectCell(0.5, b, 1 - b, 0.45));
        cells.push(...diamondSplit(b, 0.45, 1 - b, 1 - b));
        return cells;
      } },

    { name: "Diamond Lattice", build() {
        const cols = 3, rows = 5, cells = [];
        const du = 1 / cols, dv = 1 / rows;
        for (let j = 0; j <= rows; j++) {
          for (let i = 0; i <= cols; i++) {
            if ((i + j) % 2 !== 0) continue;
            const cx = i * du, cy = j * dv;
            const poly = [[cx, cy - dv], [cx + du, cy], [cx, cy + dv], [cx - du, cy]];
            const clipped = clipToUnit(poly);
            if (clipped) cells.push(clipped);
          }
        }
        return cells;
      } },

    { name: "Wheel Window", build() {
        /* 四辺に接する楕円+車輪状の割り+四隅 */
        const cells = [];
        const cx = 0.5, cy = 0.5;
        const pt = (a, f) => [cx + Math.cos(a) * 0.5 * f, cy + Math.sin(a) * 0.5 * f];
        const SEC = 8, RIN = [0, 0.55, 1];
        for (let k = 0; k < SEC; k++) {
          const a0 = Math.PI * 2 * k / SEC + Math.PI / SEC;
          const a1 = Math.PI * 2 * (k + 1) / SEC + Math.PI / SEC;
          for (let bi = 0; bi < RIN.length - 1; bi++) {
            const f0 = RIN[bi], f1 = RIN[bi + 1];
            const poly = [];
            for (let i = 0; i <= 3; i++) poly.push(pt(a0 + (a1 - a0) * i / 3, f1));
            if (f0 === 0) poly.push([cx, cy]);
            else for (let i = 3; i >= 0; i--) poly.push(pt(a0 + (a1 - a0) * i / 3, f0));
            cells.push(poly);
          }
        }
        const corners = [
          { c: [0, 0], aFrom: Math.PI * 1.5, aTo: Math.PI },
          { c: [1, 0], aFrom: Math.PI * 2,   aTo: Math.PI * 1.5 },
          { c: [1, 1], aFrom: Math.PI * 0.5, aTo: 0 },
          { c: [0, 1], aFrom: Math.PI,       aTo: Math.PI * 0.5 },
        ];
        for (const co of corners) {
          const poly = [co.c];
          for (let i = 0; i <= 6; i++) {
            poly.push(pt(co.aFrom + (co.aTo - co.aFrom) * i / 6, 1));
          }
          cells.push(poly);
        }
        return cells;
      } },

    { name: "Chevron", build() {
        const bands = 4, cols = 6, cells = [];
        for (let j = 0; j < bands; j++) {
          const vt = j / bands, vb = (j + 1) / bands;
          const y0 = j % 2 === 0 ? vb : vt;
          const y1 = j % 2 === 0 ? vt : vb;
          const pts = [];
          for (let i = 0; i <= cols; i++) {
            pts.push([i / cols, i % 2 === 0 ? y0 : y1]);
          }
          for (let i = 0; i < pts.length - 2; i++) {
            cells.push([pts[i], pts[i + 1], pts[i + 2]]);
          }
          cells.push([[0, y0], [0, y1], pts[1]]);
          cells.push([[1, pts[cols][1]], [1, pts[cols][1] === y0 ? y1 : y0], pts[cols - 1]]);
        }
        return cells;
      } },
  ];

  /* 難易度ごとに、混ざって出てくる手作り枠(セル数で振り分け)。
     hard以上は目標枚数が多いためランダム生成のみ */
  const HANDMADE_BY_DIFF = {
    easy:   ["Columns", "Door Panel", "Grand Diamond"],
    normal: ["Three Diamonds", "Sunburst", "Diamond Lattice", "Wheel Window", "Checker", "Brickwork", "Chevron"],
    hard:   [],
    vhard:  [],
  };

  /* ============================================================
     ランダム枠:目標枚数まで、いちばん大きい区画から割っていく
     ・symmetric=true  … 左半分だけ作って鏡写し(建具らしい端正さ)
     ・symmetric=false … 全面を直接分割(自由で崩れた表情)
     ============================================================ */
  /* 難易度ごとの目標セル数と、指で押せるセルの最小サイズ(px)。
     細かい難易度ほど下限も攻める */
  const DIFF_TARGET = { easy: 10, normal: 40, hard: 80, vhard: 140 };
  const DIFF_MIN_PX = { easy: 26, normal: 26, hard: 22, vhard: 19 };

  function randomFrame(diffKey, ratio, symmetric, panelW, panelH) {
    const domainW = symmetric ? 0.5 : 1;                        /* 分割する領域の幅 */
    const target = DIFF_TARGET[diffKey] * (symmetric ? 0.5 : 1); /* この領域での目標 */

    /* 絶対最小サイズを単位座標に換算。どの難易度でも、
       これより小さいセルは生まれない(押しやすさ優先で目標より減ることはある) */
    const MIN_PX = DIFF_MIN_PX[diffKey];
    const minU = MIN_PX / panelW;
    const minV = MIN_PX / panelH;
    const avgArea = domainW / target;   /* 平均セル面積(菱形の大きさ制限用) */

    const done = [];                       /* 確定したセル(菱形割りの断片など) */
    const regions = [[0, 0, domainW, 1]];  /* まだ割れる余地のある区画 */
    const total = () => done.length + regions.length;

    while (total() < target) {
      /* いちばん大きい区画から割る(順位に揺らぎを入れて機械的になりすぎないように) */
      let bi = -1, best = -1;
      for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        const w = r[2] - r[0], h = r[3] - r[1];
        if (w < minU * 2 && h < minV * 2) continue;   /* これ以上割れない */
        const score = w * h * (0.7 + Math.random() * 0.6);
        if (score > best) { best = score; bi = i; }
      }
      if (bi < 0) break;   /* 全区画が最小サイズ:ここで打ち止め */

      const [u0, v0, u1, v1] = regions.splice(bi, 1)[0];
      const w = u1 - u0, h = v1 - v0;

      /* 菱形割り:平均セルの8倍以下の適度な区画に時々。
         (巨大な区画に発動すると生成がそこで尽きてしまうため大きさを制限) */
      if (w / 2 >= minU && h / 2 >= minV && w * h <= avgArea * 8 &&
          total() + 5 <= target + 2 && Math.random() < 0.22) {
        done.push(...diamondSplit(u0, v0, u1, v1));
        continue;
      }

      /* 二分割:画面上の縦横比が整う向きに、最小サイズを守る位置で */
      const canV = w >= minU * 2, canH = h >= minV * 2;
      let vert = w * ratio > h ? true : (h > w * ratio * 1.5 ? false : Math.random() < 0.5);
      if (vert && !canV) vert = false;
      if (!vert && !canH) vert = true;
      if (vert) {
        const lo = Math.max(0.3, minU / w), hi = Math.min(0.7, 1 - minU / w);
        const mu = u0 + w * (lo + Math.random() * (hi - lo));
        regions.push([u0, v0, mu, v1], [mu, v0, u1, v1]);
      } else {
        const lo = Math.max(0.3, minV / h), hi = Math.min(0.7, 1 - minV / h);
        const mv = v0 + h * (lo + Math.random() * (hi - lo));
        regions.push([u0, v0, u1, mv], [u0, mv, u1, v1]);
      }
    }

    /* 残った区画をセル化(押せる大きさなら時々、斜め割りで彩る) */
    const half = [...done];
    for (const [u0, v0, u1, v1] of regions) {
      const w = u1 - u0, h = v1 - v0;
      if (w >= minU * 1.4 && h >= minV * 1.4 && Math.random() < 0.12) {
        half.push([[u0, v0], [u1, v0], [u1, v1]]);
        half.push([[u0, v0], [u1, v1], [u0, v1]]);
      } else {
        half.push(rectCell(u0, v0, u1, v1));
      }
    }

    /* 非対称モードは全面を直接分割済みなので、そのまま返す */
    if (!symmetric) return half;

    /* 鏡写し(u → 1-u)。頂点順を逆にして向きを保つ */
    const cells = [...half];
    for (const poly of half) {
      cells.push(poly.map(p => [1 - p[0], p[1]]).reverse());
    }
    return cells;
  }

  return {
    COLOR_FAMILIES,
    rectCell, diamondSplit, gridCells, polyArea, clipConvex, clipToUnit, UNIT_RECT, pointInPoly,
    WINDOW_SHAPES, HANDMADE, HANDMADE_BY_DIFF,
    DIFF_TARGET, DIFF_MIN_PX, randomFrame,
    TAP_MIN_PX, attachSlivers,
  };
});
