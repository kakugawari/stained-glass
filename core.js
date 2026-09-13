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

  /* セルの中にある点を1つ返す。
     頂点の平均はふつう中に入るが、扇形の輪のように凹んだセルでは外へ出る
     (実測 22689枚中16枚、Wheel Window の輪)。外に出ると、光の差し込みが
     よそに描かれ、テストで「その一枚を押す」こともできなくなる */
  function insidePoint(poly) {
    let ax = 0, ay = 0;
    for (const p of poly) { ax += p[0]; ay += p[1]; }
    ax /= poly.length; ay /= poly.length;
    if (pointInPoly(ax, ay, poly)) return [ax, ay];

    /* 三角形に切り分けて、中に入るものを探す */
    for (let i = 1; i < poly.length - 1; i++) {
      const x = (poly[0][0] + poly[i][0] + poly[i + 1][0]) / 3;
      const y = (poly[0][1] + poly[i][1] + poly[i + 1][1]) / 3;
      if (pointInPoly(x, y, poly)) return [x, y];
    }
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], c = poly[(i + 2) % poly.length];
      const x = (a[0] + b[0] + c[0]) / 3, y = (a[1] + b[1] + c[1]) / 3;
      if (pointInPoly(x, y, poly)) return [x, y];
    }
    return [ax, ay];
  }

  /* 同じ場所に並んだ点を落とす。
     重なった点があると辺の長さが 0 になり、内側へ寄せる計算ができない */
  function cleanPoly(poly, eps = 1e-9) {
    const out = [];
    for (const p of poly) {
      const q = out[out.length - 1];
      if (!q || Math.abs(p[0] - q[0]) > eps || Math.abs(p[1] - q[1]) > eps) out.push([p[0], p[1]]);
    }
    while (out.length > 3) {
      const a = out[0], b = out[out.length - 1];
      if (Math.abs(a[0] - b[0]) > eps || Math.abs(a[1] - b[1]) > eps) break;
      out.pop();
    }
    return out;
  }

  const UNIT_RECT = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const clipToUnit = poly => clipConvex(poly, UNIT_RECT);

  /* ============================================================
     塗りかけの窓を、しまう・取り出す
     ------------------------------------------------------------
     せっかく塗った窓が、閉じただけで消えるのは惜しい。
     窓の形と嵌めた硝子をそのまま文字列にして持ち歩けるようにする。
     壊れた中身を読み込んでも落ちないよう、取り出す側で必ず検める
     (別の版で保存したもの・途中で切れたもの・人が書き換えたもの)。
     ============================================================ */
  const SAVE_VERSION = 1;

  const round5 = (n) => Math.round(n * 1e5) / 1e5;   /* 小数を切って軽くする */

  /** 窓の状態を、そのまま保存できる形にする */
  function packWindow(win) {
    return {
      v: SAVE_VERSION,
      diff: win.diff,
      ratio: round5(win.ratio),
      shape: win.shape,           /* 外形の key。手作り枠なら null */
      handmade: win.handmade || null,
      familyIdx: win.familyIdx,
      completed: !!win.completed,
      cells: win.cells.map(poly => poly.map(p => [round5(p[0]), round5(p[1])])),
      fills: win.fills.slice(),
    };
  }

  /** 保存した形から窓を取り出す。少しでもおかしければ null */
  function unpackWindow(data) {
    if (!data || data.v !== SAVE_VERSION) return null;
    if (!Array.isArray(data.cells) || !Array.isArray(data.fills)) return null;
    if (data.cells.length === 0 || data.cells.length !== data.fills.length) return null;
    if (!DIFF_TARGET[data.diff]) return null;
    if (!(typeof data.ratio === 'number' && data.ratio > 0 && data.ratio < 10)) return null;
    if (data.shape !== null && data.shape !== undefined &&
        !WINDOW_SHAPES.some(s => s.key === data.shape)) return null;
    if (data.handmade !== null && data.handmade !== undefined &&
        !HANDMADE.some(f => f.name === data.handmade)) return null;

    for (const poly of data.cells) {
      if (!Array.isArray(poly) || poly.length < 3) return null;
      for (const p of poly) {
        if (!Array.isArray(p) || p.length !== 2) return null;
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
      }
    }
    for (const f of data.fills) {
      if (f !== null && !/^#[0-9a-f]{6}$/.test(f)) return null;
    }
    const familyIdx = Number.isInteger(data.familyIdx) &&
      data.familyIdx >= 0 && data.familyIdx < COLOR_FAMILIES.length ? data.familyIdx : 0;

    return {
      diff: data.diff,
      ratio: data.ratio,
      shape: data.shape || null,
      handmade: data.handmade || null,
      familyIdx,
      completed: !!data.completed && data.fills.every(f => f !== null),
      cells: data.cells.map(poly => poly.map(p => [p[0], p[1]])),
      fills: data.fills.slice(),
    };
  }

  /* 色の明るさ(0〜1)。硝子をどれだけ光らせるかを、その色の明るさで決めるのに使う。
     暗い硝子に白を足すと、深い藍も深い臙脂も、ただの中間色になってしまう */
  function relLuminance(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return 0.5;
    const f = (h) => {
      const c = parseInt(h, 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(m[1]) + 0.7152 * f(m[2]) + 0.0722 * f(m[3]);
  }

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
        for (let i = 1; i <= 16; i++) {   /* i=0 は [0, a] と重なるので飛ばす */
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
     ------------------------------------------------------------
     どの枠も、難易度の目標枚数を受け取って細かさを変える。
     同じ normal を選んだのに 12 枚の窓と 48 枚の窓が出ると、
     同じつもりで選んだ遊ぶ側には、まるで別物の手応えになる。
     枠ごとに細かさを何通りか作ってみて、目標にいちばん近いものを選ぶ
     (数えるのは実際に作った枚数なので、式を間違えてもずれない)。
     ============================================================ */
  const PANEL_R = 0.62;   /* 手作り枠の窓は縦長で固定。1枚を正方形に近づける時に使う */

  /* 細かさを振った候補の中から、枚数が目標にいちばん近いものを選ぶ */
  function closestTo(target, from, to, make) {
    /* 目標を渡し忘れても、normal の細かさで作る(枠が出ないより良い) */
    const goal = Number.isFinite(target) ? target : DIFF_TARGET.normal;
    let best = null, bestErr = Infinity;
    for (let n = from; n <= to; n++) {
      const cells = make(n);
      const err = Math.abs(cells.length - goal);
      if (err < bestErr) { bestErr = err; best = cells; }
    }
    return best;
  }

  /* 縦 n 段に対する横の列数(画面上で1枚が正方形に近くなる) */
  const colsFor = (n, min = 2) => Math.max(min, Math.round(n * PANEL_R));
  const rowsFor = (n, min = 2) => Math.max(min, Math.round(n / PANEL_R));
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /* 帯を n 等分した切れ目 */
  const cuts = (a, b, n) => {
    const out = [];
    for (let i = 0; i <= n; i++) out.push(a + (b - a) * i / n);
    return out;
  };

  const HANDMADE = [

    { name: "Checker", build(target) {
        return closestTo(target, 1, 22, (n) => gridCells(colsFor(n), n));
      } },

    { name: "Grand Diamond", build(target) {
        /* 縁取りの中に大きな菱形。細かい時は菱形をいくつも並べる */
        const make = (rows) => {
          const cols = colsFor(rows, 1);
          const b = Math.min(0.13, 0.42 / (rows + 1));
          const u = cuts(b, 1 - b, cols), v = cuts(b, 1 - b, rows);
          const cells = [
            rectCell(0, 0, b, b), rectCell(1 - b, 0, 1, b),
            rectCell(0, 1 - b, b, 1), rectCell(1 - b, 1 - b, 1, 1),
          ];
          for (let i = 0; i < cols; i++) {
            cells.push(rectCell(u[i], 0, u[i + 1], b), rectCell(u[i], 1 - b, u[i + 1], 1));
          }
          for (let j = 0; j < rows; j++) {
            cells.push(rectCell(0, v[j], b, v[j + 1]), rectCell(1 - b, v[j], 1, v[j + 1]));
          }
          for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
              cells.push(...diamondSplit(u[i], v[j], u[i + 1], v[j + 1]));
            }
          }
          return cells;
        };
        return closestTo(target, 1, 8, make);
      } },

    { name: "Three Diamonds", build(target) {
        /* 両脇に細い帯、その内側に菱形を並べる */
        const make = (rows) => {
          const cols = colsFor(rows, 1);
          const s = Math.min(0.16, 0.42 / (rows + 1));
          const u = cuts(s, 1 - s, cols), v = cuts(0, 1, rows);
          const cells = [];
          for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
              cells.push(...diamondSplit(u[i], v[j], u[i + 1], v[j + 1]));
            }
          }
          const side = rows + 1;
          for (let j = 0; j < side; j++) {
            cells.push(rectCell(0, j / side, s, (j + 1) / side));
            cells.push(rectCell(1 - s, j / side, 1, (j + 1) / side));
          }
          return cells;
        };
        return closestTo(target, 1, 8, make);
      } },

    { name: "Sunburst", build(target) {
        /* 窓の下辺を中心に、扇が広がる */
        const make = (n) => {
          const N = Math.max(3, n);
          const R = clamp(Math.round(n / 2.5), 2, 5);
          const ox = 0.5, oy = 1.0, AR = 0.62;
          const bands = [0];
          for (let r = 1; r <= R; r++) {
            bands.push(0.5 * Math.pow(2.2 / 0.5, (r - 1) / Math.max(1, R - 1)));
          }
          const pt = (a, r) => [ox + Math.cos(a) * r, oy + Math.sin(a) * r * AR];
          const cells = [];
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
        };
        return closestTo(target, 3, 20, make);
      } },

    { name: "Columns", build(target) {
        /* 縦の柱。隣り合う柱で継ぎ目をずらす */
        const make = (cols) => {
          const rows = rowsFor(cols);
          const cells = [];
          for (let i = 0; i < cols; i++) {
            const k = i % 2 === 0 ? rows : Math.max(1, rows - 1);
            const v = cuts(0, 1, k);
            for (let j = 0; j < k; j++) {
              cells.push(rectCell(i / cols, v[j], (i + 1) / cols, v[j + 1]));
            }
          }
          return cells;
        };
        return closestTo(target, 2, 14, make);
      } },

    { name: "Brickwork", build(target) {
        /* 煉瓦積み。一段おきに半分ずらす */
        const make = (rows) => {
          const cols = colsFor(rows);
          const cells = [];
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
        };
        return closestTo(target, 1, 20, make);
      } },

    { name: "Door Panel", build(target) {
        /* 上は素直な格子、下は菱形。扉の硝子のような割り */
        const make = (rows) => {
          const cols = colsFor(rows, 1);
          const b = Math.min(0.15, 0.42 / (rows + 1));
          const mid = 0.45;
          const up = Math.max(1, Math.round(rows * 0.45));
          const lo = Math.max(1, rows - up);
          const u = cuts(b, 1 - b, cols);
          const vSide = cuts(b, 1 - b, rows);
          const vUp = cuts(b, mid, up), vLo = cuts(mid, 1 - b, lo);
          const cells = [
            rectCell(0, 0, b, b), rectCell(1 - b, 0, 1, b),
            rectCell(0, 1 - b, b, 1), rectCell(1 - b, 1 - b, 1, 1),
          ];
          for (let i = 0; i < cols; i++) {
            cells.push(rectCell(u[i], 0, u[i + 1], b), rectCell(u[i], 1 - b, u[i + 1], 1));
          }
          for (let j = 0; j < rows; j++) {
            cells.push(rectCell(0, vSide[j], b, vSide[j + 1]),
                       rectCell(1 - b, vSide[j], 1, vSide[j + 1]));
          }
          for (let j = 0; j < up; j++) {
            for (let i = 0; i < cols; i++) cells.push(rectCell(u[i], vUp[j], u[i + 1], vUp[j + 1]));
          }
          for (let j = 0; j < lo; j++) {
            for (let i = 0; i < cols; i++) {
              cells.push(...diamondSplit(u[i], vLo[j], u[i + 1], vLo[j + 1]));
            }
          }
          return cells;
        };
        return closestTo(target, 1, 8, make);
      } },

    { name: "Diamond Lattice", build(target) {
        /* 菱形の格子 */
        const make = (cols) => {
          const rows = rowsFor(cols);
          const du = 1 / cols, dv = 1 / rows;
          const cells = [];
          for (let j = 0; j <= rows; j++) {
            for (let i = 0; i <= cols; i++) {
              if ((i + j) % 2 !== 0) continue;
              const cx = i * du, cy = j * dv;
              const clipped = clipToUnit([[cx, cy - dv], [cx + du, cy], [cx, cy + dv], [cx - du, cy]]);
              if (clipped) cells.push(clipped);
            }
          }
          return cells;
        };
        return closestTo(target, 2, 16, make);
      } },

    { name: "Wheel Window", build(target) {
        /* 四辺に接する楕円+車輪状の割り+四隅 */
        const make = (n) => {
          const SEC = clamp(n * 2, 6, 28);
          const RIN = clamp(Math.round(n / 2), 2, 5);
          const cx = 0.5, cy = 0.5;
          const pt = (a, f) => [cx + Math.cos(a) * 0.5 * f, cy + Math.sin(a) * 0.5 * f];
          const rings = [0];
          for (let r = 1; r <= RIN; r++) rings.push(r / RIN);
          const cells = [];
          for (let k = 0; k < SEC; k++) {
            const a0 = Math.PI * 2 * k / SEC + Math.PI / SEC;
            const a1 = Math.PI * 2 * (k + 1) / SEC + Math.PI / SEC;
            for (let bi = 0; bi < rings.length - 1; bi++) {
              const f0 = rings[bi], f1 = rings[bi + 1];
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
            for (let i = 0; i <= 6; i++) poly.push(pt(co.aFrom + (co.aTo - co.aFrom) * i / 6, 1));
            cells.push(poly);
          }
          return cells;
        };
        return closestTo(target, 3, 14, make);
      } },

    { name: "Chevron", build(target) {
        /* 山形の帯を積む */
        const make = (bands) => {
          const cols = Math.max(3, Math.round(bands * 1.6));
          const cells = [];
          for (let j = 0; j < bands; j++) {
            const vt = j / bands, vb = (j + 1) / bands;
            const y0 = j % 2 === 0 ? vb : vt;
            const y1 = j % 2 === 0 ? vt : vb;
            const pts = [];
            for (let i = 0; i <= cols; i++) pts.push([i / cols, i % 2 === 0 ? y0 : y1]);
            for (let i = 0; i < pts.length - 2; i++) cells.push([pts[i], pts[i + 1], pts[i + 2]]);
            cells.push([[0, y0], [0, y1], pts[1]]);
            cells.push([[1, pts[cols][1]], [1, pts[cols][1] === y0 ? y1 : y0], pts[cols - 1]]);
          }
          return cells;
        };
        return closestTo(target, 1, 14, make);
      } },
  ];

  /* ============================================================
     どの手作り枠を、どの難易度に混ぜるか
     ------------------------------------------------------------
     条件は2つ。
       ・枚数がその難易度の目標のまわりに収まる
         (同じ難易度を選んだのに手応えが別物にならない)
       ・どのセルも指で押せる大きさ(手のひらに収まる画面を基準に)
     枠によっては、細かくすると中心の一枚が小さくなりすぎて
     この条件を満たせない。その難易度には出さない。
     下の表は fitsDifficulty で決めたもの。テストで照らし合わせている
     ので、枠を足したり形を変えたりしたら、そこで気づける。
     ============================================================ */
  const FIT_PANEL = { w: 255, h: 411 };   /* ふつうのスマホでの窓の大きさ(px) */

  /* 目標からどこまで離れてよいか。easy は枚数が少ないので、幅も少し持たせる */
  const fitSlack = (target) => Math.max(4, target * 0.35);

  function fitsDifficulty(frame, diffKey) {
    const target = DIFF_TARGET[diffKey];
    const cells = frame.build(target);
    if (Math.abs(cells.length - target) > fitSlack(target)) return false;
    for (const c of cells) {
      const xs = c.map(p => p[0]), ys = c.map(p => p[1]);
      const w = (Math.max(...xs) - Math.min(...xs)) * FIT_PANEL.w;
      const h = (Math.max(...ys) - Math.min(...ys)) * FIT_PANEL.h;
      if (Math.min(w, h) < TAP_MIN_PX) return false;
    }
    return true;
  }

  const HANDMADE_BY_DIFF = {
    easy:   ["Checker", "Grand Diamond", "Three Diamonds", "Sunburst", "Columns",
             "Brickwork", "Door Panel", "Diamond Lattice", "Chevron"],
    normal: ["Checker", "Grand Diamond", "Three Diamonds", "Columns", "Brickwork",
             "Door Panel", "Diamond Lattice", "Wheel Window", "Chevron"],
    hard:   ["Checker", "Columns", "Brickwork", "Diamond Lattice", "Chevron"],
    vhard:  ["Checker", "Columns", "Diamond Lattice", "Chevron"],
  };

  /* ============================================================
     縁取りの帯
     ------------------------------------------------------------
     本物の窓は、たいてい外周に硝子の帯をめぐらせている。それが無いと、
     どこまで行っても均質なモザイクに見える。
     外形を画面の上で何 px か内側へ寄せた形を作り、外と内のあいだを
     辺ごとに細長い硝子へ割る。内側は今までどおりの割り方で埋める。
     ============================================================ */

  /* 凸多角形を、画面の上で d px ぶん内側へ寄せる。
     辺の数は変えない(外と内の辺が1対1で対応する)ので、間を帯に割れる。
     痩せて形が壊れるときは null */
  function insetConvex(poly, d, panelW, panelH) {
    const px = poly.map(p => [p[0] * panelW, p[1] * panelH]);
    let cx = 0, cy = 0;
    for (const p of px) { cx += p[0]; cy += p[1]; }
    cx /= px.length; cy /= px.length;

    /* 各辺を、内側へ d だけずらした直線 */
    const lines = [];
    for (let i = 0; i < px.length; i++) {
      const a = px[i], b = px[(i + 1) % px.length];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const len = Math.hypot(ex, ey);
      if (len < 1e-9) return null;
      let nx = -ey / len, ny = ex / len;
      if ((cx - a[0]) * nx + (cy - a[1]) * ny < 0) { nx = -nx; ny = -ny; }   /* 内向きへ */
      lines.push({ x: a[0] + nx * d, y: a[1] + ny * d, dx: ex / len, dy: ey / len });
    }

    /* 隣り合う直線の交点が、内側の形の角になる */
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const p = lines[(i - 1 + lines.length) % lines.length], q = lines[i];
      const den = p.dx * q.dy - p.dy * q.dx;
      if (Math.abs(den) < 1e-9) return null;                    /* 平行で角が出せない */
      const t = ((q.x - p.x) * q.dy - (q.y - p.y) * q.dx) / den;
      out.push([(p.x + p.dx * t) / panelW, (p.y + p.dy * t) / panelH]);
    }

    /* 痩せすぎ・ねじれの見張り。おかしければ縁取りをあきらめる */
    const areaIn = Math.abs(polyArea(out)), areaOut = Math.abs(polyArea(poly));
    if (!(areaIn > areaOut * 0.25)) return null;
    for (const p of out) {
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
      if (!pointInPoly(p[0], p[1], poly)) return null;
    }
    return out;
  }

  /* 外と内のあいだを、辺ごとに細長い硝子へ割る */
  function ringCells(outer, inner, pieceLenPx, panelW, panelH) {
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const cells = [];
    for (let i = 0; i < outer.length; i++) {
      const o0 = outer[i], o1 = outer[(i + 1) % outer.length];
      const i0 = inner[i], i1 = inner[(i + 1) % inner.length];
      const len = Math.hypot((o1[0] - o0[0]) * panelW, (o1[1] - o0[1]) * panelH);
      const k = Math.max(1, Math.round(len / pieceLenPx));
      for (let j = 0; j < k; j++) {
        const t0 = j / k, t1 = (j + 1) / k;
        cells.push([lerp(o0, o1, t0), lerp(o0, o1, t1), lerp(i0, i1, t1), lerp(i0, i1, t0)]);
      }
    }
    return cells;
  }

  /* 縁取りを付けられる難易度。easy は帯だけで枚数を使い切ってしまう
     (帯は外周をめぐるので、窓が粗くても枚数は減らない) */
  const BORDER_MIN_TARGET = 40;

  /* 帯の幅と、帯を割る長さ。どちらも指で押せる大きさを必ず超える。
     幅は短いほうの辺の1割、割る長さはその3倍。見比べてこの形に決めた
     (細いと帯に見えず、短く割ると内側に回す枚数が無くなる) */
  function borderPlan(diffKey, panelW, panelH) {
    const band = Math.max(TAP_MIN_PX + 2, Math.min(panelW, panelH) * 0.10);
    return { band, pieceLen: band * 3 };
  }

  /* ============================================================
     窓を1枚ぶん作る(縁取り + 内側)。画面を触らないのでここに置ける
     ============================================================ */
  function makeWindow(opts) {
    const { diff, symmetric, panelW, panelH } = opts;
    const shapePoly = cleanPoly(opts.shapePoly);
    const target = DIFF_TARGET[diff];
    const withBorder = opts.border && target >= BORDER_MIN_TARGET;

    const build = (border) => {
      const cells = [];
      let inner = shapePoly;
      if (border) {
        const plan = borderPlan(diff, panelW, panelH);
        const ins = insetConvex(shapePoly, plan.band, panelW, panelH);
        if (ins) {
          cells.push(...ringCells(shapePoly, ins, plan.pieceLen, panelW, panelH));
          inner = ins;
        }
      }
      /* 内側は、その形の外接四角のなかで割ってから、形で切り抜く */
      let u0 = 1, v0 = 1, u1 = 0, v1 = 0;
      for (const p of inner) {
        u0 = Math.min(u0, p[0]); u1 = Math.max(u1, p[0]);
        v0 = Math.min(v0, p[1]); v1 = Math.max(v1, p[1]);
      }
      const w = (u1 - u0) * panelW, h = (v1 - v0) * panelH;
      const raw = randomFrame(diff, w / h, symmetric, w, h, Math.max(4, target - cells.length));
      for (const poly of raw) {
        const mapped = poly.map(p => [u0 + p[0] * (u1 - u0), v0 + p[1] * (v1 - v0)]);
        const c = clipConvex(mapped, inner);
        if (c) cells.push(c);
      }
      return cells;
    };

    const cells = build(withBorder);
    if (!withBorder || cells.length >= target * 0.8) return cells;

    /* 小さい画面の四角窓・丸窓では、帯が面積を食って枚数が落ちる。
       そういう時は帯をあきらめ、目標に近いほうを採る
       (同じ難易度なら同じ手応え、を枚数で守る) */
    const plain = build(false);
    return Math.abs(plain.length - target) < Math.abs(cells.length - target) ? plain : cells;
  }

  /* ============================================================
     ランダム枠:目標枚数まで、いちばん大きい区画から割っていく
     ・symmetric=true  … 左半分だけ作って鏡写し(建具らしい端正さ)
     ・symmetric=false … 全面を直接分割(自由で崩れた表情)
     ============================================================ */
  /* 難易度ごとの目標セル数と、指で押せるセルの最小サイズ(px)。
     細かい難易度ほど下限も攻める */
  const DIFF_TARGET = { easy: 10, normal: 40, hard: 80, vhard: 140 };
  const DIFF_MIN_PX = { easy: 26, normal: 26, hard: 22, vhard: 19 };

  function randomFrame(diffKey, ratio, symmetric, panelW, panelH, want) {
    const domainW = symmetric ? 0.5 : 1;                        /* 分割する領域の幅 */
    const goal = Number.isFinite(want) ? Math.max(2, want) : DIFF_TARGET[diffKey];
    const target = goal * (symmetric ? 0.5 : 1);                 /* この領域での目標 */

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
    COLOR_FAMILIES, relLuminance,
    rectCell, diamondSplit, gridCells, polyArea, clipConvex, clipToUnit, UNIT_RECT, pointInPoly, insidePoint, cleanPoly,
    WINDOW_SHAPES, HANDMADE, HANDMADE_BY_DIFF, fitsDifficulty, fitSlack, FIT_PANEL,
    DIFF_TARGET, DIFF_MIN_PX, randomFrame,
    insetConvex, ringCells, borderPlan, makeWindow, BORDER_MIN_TARGET,
    TAP_MIN_PX, attachSlivers,
    SAVE_VERSION, packWindow, unpackWindow,
  };
});
