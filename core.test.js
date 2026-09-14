/*
 * ロジックのテスト:  npm test   (node だけで動く。速い)
 *
 * 見張っているのは「窓として成り立っているか」。
 *   ・隙間も重なりもなく窓を埋めているか
 *   ・指で押せない大きさのセルが混ざっていないか
 *   ・外形はすべて凸か (clipConvex がそれを前提にしている)
 */
const test = require('node:test');
const assert = require('node:assert');
const C = require('./core.js');

/* ---------- 測るための小道具 ---------- */

const bbox = (poly) => {
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  return { u0: Math.min(...xs), u1: Math.max(...xs), v0: Math.min(...ys), v1: Math.max(...ys) };
};
const sumArea = (cells) => cells.reduce((a, c) => a + Math.abs(C.polyArea(c)), 0);
const inUnit = (poly) =>
  poly.every(p => p[0] >= -1e-9 && p[0] <= 1 + 1e-9 && p[1] >= -1e-9 && p[1] <= 1 + 1e-9);

/* 頂点をたどって曲がる向きが変わらなければ凸 */
function isConvex(poly) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], c = poly[(i + 2) % poly.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-12) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/* セルの並びが同じか(重心で見る)。
   並べ替えて突き合わせると、浮動小数の微差で順番が入れ替わることがある。
   相手のいちばん近い重心を探して、1対1に対応づくかで見る */
function sameCells(a, b, eps = 1e-6) {
  const mid = (cells) => cells.map(c => {
    let cx = 0, cy = 0;
    for (const p of c) { cx += p[0]; cy += p[1]; }
    return [cx / c.length, cy / c.length];
  });
  const x = mid(a), y = mid(b);
  if (x.length !== y.length) return false;
  const used = new Array(y.length).fill(false);
  for (const p of x) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < y.length; i++) {
      if (used[i]) continue;
      const d = Math.hypot(p[0] - y[i][0], p[1] - y[i][1]);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0 || bestD > eps) return false;
    used[best] = true;
  }
  return true;
}

const DIFFS = C.DIFF_ORDER;   /* 段を足したらテストも一緒に増える */
/* スマホの細い画面・大きめの画面・その中間 */
const PANELS = [[220, 355], [300, 484], [500, 806]];

/* ---------- 窓の外形 ---------- */

test('外形はどれも凸(clipConvex が凸を前提にしている)', () => {
  for (const s of C.WINDOW_SHAPES) {
    assert.ok(isConvex(s.poly()), `${s.name} が凸でない`);
  }
});

test('外形は単位座標(0〜1)に収まり、縦横比が正', () => {
  for (const s of C.WINDOW_SHAPES) {
    assert.ok(inUnit(s.poly()), `${s.name} が枠からはみ出す`);
    assert.ok(s.ratio > 0, `${s.name} の縦横比が不正`);
    assert.ok(Math.abs(C.polyArea(s.poly())) > 0.5, `${s.name} の面積が小さすぎる`);
  }
});

/* ---------- 切り抜き ---------- */

test('中に収まっている形は切っても変わらない', () => {
  const cell = C.rectCell(0.2, 0.2, 0.6, 0.7);
  const clipped = C.clipToUnit(cell);
  assert.ok(clipped);
  assert.ok(Math.abs(Math.abs(C.polyArea(clipped)) - 0.4 * 0.5) < 1e-9);
});

test('はみ出した分だけ削られる', () => {
  const clipped = C.clipToUnit(C.rectCell(0.5, 0.5, 1.5, 1.5));   /* 1/4 だけ中 */
  assert.ok(clipped);
  assert.ok(Math.abs(Math.abs(C.polyArea(clipped)) - 0.25) < 1e-9);
  assert.ok(inUnit(clipped));
});

test('外に出た形と、削りかすのような極小の形は消える', () => {
  assert.strictEqual(C.clipToUnit(C.rectCell(1.5, 1.5, 2, 2)), null);
  assert.strictEqual(C.clipToUnit(C.rectCell(0.999, 0.999, 1.5, 1.5)), null);
});

/* ---------- 点の判定(タップ先の決め方) ---------- */

test('点が中か外か', () => {
  assert.ok(C.pointInPoly(0.5, 0.5, C.UNIT_RECT));
  assert.ok(!C.pointInPoly(1.5, 0.5, C.UNIT_RECT));
  assert.ok(!C.pointInPoly(0.5, -0.2, C.UNIT_RECT));
  const tri = [[0, 0], [1, 0], [0, 1]];
  assert.ok(C.pointInPoly(0.2, 0.2, tri));
  assert.ok(!C.pointInPoly(0.8, 0.8, tri), '斜辺の外は外');
});

test('どのセルにも、その中にある点をちゃんと返す', () => {
  /* 押す場所を決めるのに使う。外に出ると、そのセルは押せない */
  const check = (cells, what) => {
    for (const cell of cells) {
      const [u, v] = C.insidePoint(cell);
      assert.ok(C.pointInPoly(u, v, cell),
        `${what}: 返した点 (${u.toFixed(3)}, ${v.toFixed(3)}) がセルの外`);
    }
  };
  for (const shape of C.WINDOW_SHAPES) {
    for (const diff of DIFFS) {
      for (let t = 0; t < 5; t++) {
        const cells = C.randomFrame(diff, shape.ratio, t % 2 === 0, 300, 484)
          .map(p => (shape.key === 'rect' || shape.key === 'square' ? p : C.clipConvex(p, shape.poly())))
          .filter(Boolean);
        check(cells, `${shape.name} ${diff}`);
      }
    }
  }
  for (const frame of C.HANDMADE) {
    for (const diff of DIFFS) check(frame.build(C.DIFF_TARGET[diff]), `${frame.name} ${diff}`);
  }
});

/* ---------- ランダム枠 ---------- */

test('ランダム枠は窓を隙間なく、重なりなく埋める', () => {
  for (const [PW, PH] of PANELS) {
    for (const diff of DIFFS) {
      for (let t = 0; t < 20; t++) {
        const cells = C.randomFrame(diff, PW / PH, t % 2 === 0, PW, PH);
        assert.ok(Math.abs(sumArea(cells) - 1) < 1e-9,
          `${diff} ${PW}x${PH}: 面積の合計が 1 でない (${sumArea(cells)})`);
        /* 適当な点をとると、必ずちょうど 1 枚に入る */
        for (let k = 0; k < 25; k++) {
          const u = Math.random(), v = Math.random();
          const hit = cells.filter(c => C.pointInPoly(u, v, c)).length;
          assert.strictEqual(hit, 1,
            `${diff} ${PW}x${PH}: (${u.toFixed(3)}, ${v.toFixed(3)}) が ${hit} 枚に入った`);
        }
      }
    }
  }
});

test('どの難易度でも、指で押せない大きさのセルは作らない', () => {
  for (const [PW, PH] of PANELS) {
    for (const diff of DIFFS) {
      const limit = C.DIFF_MIN_PX[diff];
      for (let t = 0; t < 20; t++) {
        for (const cell of C.randomFrame(diff, PW / PH, t % 2 === 0, PW, PH)) {
          const b = bbox(cell);
          const w = (b.u1 - b.u0) * PW, h = (b.v1 - b.v0) * PH;
          assert.ok(Math.min(w, h) >= limit - 1e-6,
            `${diff} ${PW}x${PH}: ${w.toFixed(1)}x${h.toFixed(1)}px は ${limit}px より小さい`);
        }
      }
    }
  }
});

test('難易度が上がるほど枚数が増える(目標のまわりに収まる)', () => {
  /* 目標ちょうどにはならない。押しやすさ(最小サイズ)を優先して
     途中で割るのをやめるので、目標を下回ることがある。
     どこまでなら「その難易度らしい」と言えるかを、ここで決めておく */
  const PW = 300, PH = 484;
  const avg = {};
  for (const diff of DIFFS) {
    const target = C.DIFF_TARGET[diff];
    const counts = [];
    for (let t = 0; t < 40; t++) {
      counts.push(C.randomFrame(diff, PW / PH, t % 2 === 0, PW, PH).length);
    }
    avg[diff] = counts.reduce((a, b) => a + b, 0) / counts.length;
    const lo = Math.min(...counts), hi = Math.max(...counts);
    assert.ok(lo >= target * 0.7,
      `${diff}: ${lo} 枚まで減る (目標 ${target} の7割 ${(target * 0.7).toFixed(0)} 未満)`);
    assert.ok(hi <= target * 1.3 + 6,
      `${diff}: ${hi} 枚まで増える (目標 ${target} に対して多すぎる)`);
  }
  assert.ok(avg.veasy < avg.easy && avg.easy < avg.normal &&
            avg.normal < avg.hard && avg.hard < avg.vhard,
    `枚数が難易度順に増えていない: ${JSON.stringify(avg)}`);
});

test('段の間隔がそろっている(どこかだけが崖にならない)', () => {
  const t = C.DIFF_ORDER.map(k => C.DIFF_TARGET[k]);
  const steps = [];
  for (let i = 1; i < t.length; i++) steps.push(t[i] / t[i - 1]);
  for (const r of steps) {
    assert.ok(r > 1, `段が増えていない: ${steps.join(' / ')}`);
  }
  /* いちばん広い段が、いちばん狭い段の 1.5 倍を超えない。
     10→40 の4倍 と 80→140 の1.75倍 が並んでいた頃に戻さないため */
  const spread = Math.max(...steps) / Math.min(...steps);
  assert.ok(spread <= 1.5,
    `段の間隔がそろっていない (${steps.map(r => r.toFixed(2) + '倍').join(' / ')})`);
});

test('どの段も、押す枚数が目標の帯に収まる(帯から外れたら引き直す)', () => {
  const shapes = C.WINDOW_SHAPES;
  for (const diff of DIFFS) {
    const target = C.DIFF_TARGET[diff];
    for (let t = 0; t < 24; t++) {
      const shape = shapes[t % shapes.length];
      const [PW, PH] = [300, 300 / shape.ratio];
      const made = C.buildInBand(diff, PW, PH, () => ({
        cells: C.makeWindow({
          diff, shapePoly: shape.poly(), symmetric: t % 2 === 0,
          panelW: PW, panelH: PH, border: true, curve: true,
          curveChance: 0.5, curveBow: 0.11,
        }),
        panelW: PW, panelH: PH,
      }));
      const taps = C.tappableCount(made.cells, PW, PH);
      assert.ok(C.inTargetBand(taps, diff),
        `${diff}/${shape.name}: ${taps} 枚 (目標 ${target} ± ${C.fitSlack(target).toFixed(1)})`);
    }
  }
});

test('許容幅はどの段も同じ割合(枚数の少ない段だけ広くしない)', () => {
  for (const k of DIFFS) {
    const t = C.DIFF_TARGET[k];
    assert.ok(C.fitSlack(t) / t <= 0.351,
      `${k}: 目標 ${t} に対して許容 ±${C.fitSlack(t)} (${(C.fitSlack(t) / t * 100).toFixed(0)}%)`);
  }
});

test('押せるセルは、狙った一点を1px ずらしても同じセルに入る', () => {
  /* 三日月のようなセルは外枠が大きくても どこも細い。中の一点がふちすれすれだと、
     そこを狙って押しても隣のセルに入ってしまう(丸め誤差1px で逃げる) */
  const shapes = C.WINDOW_SHAPES;
  let checked = 0;
  for (const diff of DIFFS) {
    for (let t = 0; t < 16; t++) {
      const shape = shapes[t % shapes.length];
      const PW = 300, PH = 300 / shape.ratio;
      const cells = C.makeWindow({
        diff, shapePoly: shape.poly(), symmetric: t % 2 === 0,
        panelW: PW, panelH: PH, border: true, curve: true,
        curveChance: 0.5, curveBow: 0.11,
      });
      const host = C.attachSlivers(cells, PW, PH);
      for (let i = 0; i < cells.length; i++) {
        if (host[i] !== i) continue;
        const [u, v] = C.insidePoint(cells[i]);
        assert.ok(C.pointInPoly(u, v, cells[i]),
          `${diff}/${shape.name}: 中の一点が外に出た`);
        /* 上下左右に 1px ずらしても、まだそのセルの中 */
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          assert.ok(C.pointInPoly(u + dx / PW, v + dy / PH, cells[i]),
            `${diff}/${shape.name}: 中の一点がふちから 1px 以内`);
        }
        checked++;
      }
    }
  }
  assert.ok(checked > 2000, `確かめた枚数が少なすぎる (${checked})`);
});

test('押す枚数は、預けたかけらを数えない', () => {
  /* 右下に、指では押せない細片をわざと作る */
  const cells = [
    C.rectCell(0, 0, 1, 0.5), C.rectCell(0, 0.5, 1, 0.98),
    C.rectCell(0, 0.98, 1, 1),                        /* 高さ 2% = 8px のかけら */
  ];
  assert.strictEqual(cells.length, 3);
  assert.strictEqual(C.tappableCount(cells, 255, 411), 2);
});

test('対称モードは左右対称になる', () => {
  for (let t = 0; t < 10; t++) {
    const cells = C.randomFrame('normal', 0.62, true, 300, 484);
    assert.ok(sameCells(cells, cells.map(c => c.map(p => [1 - p[0], p[1]]))), '鏡写しにならない');
  }
});

/* ---------- 押せないかけら(外形で切り抜いた時) ---------- */

test('外形で切り抜くと、指で押せない細いかけらが生まれる', () => {
  /* この前提が崩れたら(=切り抜いてもかけらが出なくなったら)
     下の「預ける」仕掛けは要らなくなる。その時はここで気づける */
  const rose = C.WINDOW_SHAPES.find(s => s.key === 'circle');
  const PW = 335, PH = 335;
  let thin = 0;
  for (let t = 0; t < 20; t++) {
    for (const raw of C.randomFrame('vhard', rose.ratio, t % 2 === 0, PW, PH)) {
      const cell = C.clipConvex(raw, rose.poly());
      if (!cell) continue;
      const b = bbox(cell);
      if (Math.min((b.u1 - b.u0) * PW, (b.v1 - b.v0) * PH) < C.TAP_MIN_PX) thin++;
    }
  }
  assert.ok(thin > 0, 'かけらが出なくなった(仕掛けを見直すこと)');
});

test('切り抜いたあとも、すべてのセルが指で押して嵌められる', () => {
  for (const [PW, PH] of PANELS) {
    for (const shape of C.WINDOW_SHAPES) {
      const poly = shape.poly();
      for (const diff of DIFFS) {
        for (let t = 0; t < 6; t++) {
          const cells = C.randomFrame(diff, shape.ratio, t % 2 === 0, PW, PH)
            .map(p => C.clipConvex(p, poly)).filter(Boolean);
          const host = C.attachSlivers(cells, PW, PH);

          assert.strictEqual(host.length, cells.length);
          for (let i = 0; i < cells.length; i++) {
            const h = host[i];
            assert.ok(h >= 0 && h < cells.length, `${shape.name} ${diff}: 持ち主がいない`);
            /* 持ち主は自分自身を持ち主とする = 押せる大きさ */
            assert.strictEqual(host[h], h, `${shape.name} ${diff}: 持ち主がまた預けている`);
            const b = bbox(cells[h]);
            const w = (b.u1 - b.u0) * PW, hh = (b.v1 - b.v0) * PH;
            assert.ok(Math.min(w, hh) >= C.TAP_MIN_PX - 1e-6,
              `${shape.name} ${diff} ${PW}x${PH}: 持ち主が ${Math.min(w, hh).toFixed(1)}px で押せない`);
          }
        }
      }
    }
  }
});

test('目標を渡し忘れても、枠は作られる(normal の細かさ)', () => {
  const a = C.HANDMADE[0].build();
  const b = C.HANDMADE[0].build(C.DIFF_TARGET.normal);
  assert.ok(Array.isArray(a) && a.length === b.length);
});

test('押せる大きさのセルは、自分で自分の持ち主になる(勝手にまとめない)', () => {
  const cells = C.HANDMADE.find(f => f.name === 'Checker').build(C.DIFF_TARGET.normal);
  const host = C.attachSlivers(cells, 300, 484);
  assert.deepStrictEqual(host, cells.map((_, i) => i));
});

/* ---------- 縁取りの帯 ---------- */

test('重なった点は落とす(外形にひとつ紛れていた)', () => {
  assert.deepStrictEqual(C.cleanPoly([[0, 0], [1, 0], [1, 0], [1, 1], [0, 0]]),
                         [[0, 0], [1, 0], [1, 1]]);
  for (const shape of C.WINDOW_SHAPES) {
    const clean = C.cleanPoly(shape.poly());
    for (let i = 0; i < clean.length; i++) {
      const a = clean[i], b = clean[(i + 1) % clean.length];
      assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9, `${shape.name}: 同じ点が並んでいる`);
    }
  }
});


const SHAPE_PANELS = (shape, PW = 300) => {
  const w = shape.ratio >= 1 ? Math.min(PW, 480) : PW;
  return [w, w / shape.ratio];
};

test('内側へ寄せた形は、外形の中にきちんと収まる', () => {
  for (const shape of C.WINDOW_SHAPES) {
    const poly = C.cleanPoly(shape.poly());   /* 重なった点があると辺の長さが 0 になる */
    const [PW, PH] = SHAPE_PANELS(shape);
    const inner = C.insetConvex(poly, 24, PW, PH);
    assert.ok(inner, `${shape.name}: 内側の形が作れない`);
    assert.strictEqual(inner.length, poly.length, `${shape.name}: 辺の数が変わった`);
    for (const p of inner) {
      assert.ok(C.pointInPoly(p[0], p[1], poly), `${shape.name}: 内側の角が外形からはみ出した`);
    }
    assert.ok(Math.abs(C.polyArea(inner)) < Math.abs(C.polyArea(poly)), `${shape.name}: 小さくなっていない`);
  }
});

test('太らせすぎたら、縁取りをあきらめる(null を返す)', () => {
  const shape = C.WINDOW_SHAPES[0];
  const [PW, PH] = SHAPE_PANELS(shape);
  assert.strictEqual(C.insetConvex(C.cleanPoly(shape.poly()), PW, PW, PH), null,
    '窓が消えるほどの幅でも作ってしまう');
});

test('帯は外周をひとまわりし、外と内のあいだを埋める', () => {
  for (const shape of C.WINDOW_SHAPES) {
    const poly = C.cleanPoly(shape.poly());
    const [PW, PH] = SHAPE_PANELS(shape);
    const plan = C.borderPlan('normal', PW, PH);
    const inner = C.insetConvex(poly, plan.band, PW, PH);
    const ring = C.ringCells(poly, inner, plan.pieceLen, PW, PH);
    const gap = Math.abs(C.polyArea(poly)) - Math.abs(C.polyArea(inner));
    assert.ok(Math.abs(sumArea(ring) - gap) < 1e-9,
      `${shape.name}: 帯の面積が合わない (${sumArea(ring).toFixed(4)} / ${gap.toFixed(4)})`);
    for (const cell of ring) {
      const b = bbox(cell);
      const w = (b.u1 - b.u0) * PW, h = (b.v1 - b.v0) * PH;
      assert.ok(Math.min(w, h) >= C.TAP_MIN_PX,
        `${shape.name}: 帯に ${Math.min(w, h).toFixed(1)}px のセルがある`);
    }
  }
});

test('縁取りを付けても、窓は隙間なく重なりなく埋まる', () => {
  for (const shape of C.WINDOW_SHAPES) {
    const poly = shape.poly();
    const [PW, PH] = SHAPE_PANELS(shape);
    const shapeArea = Math.abs(C.polyArea(poly));
    for (const diff of DIFFS) {
      for (let t = 0; t < 4; t++) {
        const cells = C.makeWindow({ diff, shapePoly: poly, symmetric: t % 2 === 0,
                                     panelW: PW, panelH: PH, border: true });
        assert.ok(Math.abs(sumArea(cells) - shapeArea) < 0.002,
          `${shape.name} ${diff}: 面積が合わない (${sumArea(cells).toFixed(4)} / ${shapeArea.toFixed(4)})`);
        /* 適当な点は、ちょうど1枚に入る */
        const inset = C.insetConvex(poly, 2, PW, PH);   /* ふち上の点は判定がぶれるので少しだけ内側で見る */
        for (let k = 0; k < 20; k++) {
          const u = Math.random(), v = Math.random();
          if (!C.pointInPoly(u, v, poly)) continue;          /* 窓の外は見ない */
          const hit = cells.filter(c => C.pointInPoly(u, v, c)).length;
          assert.ok(hit <= 1, `${shape.name} ${diff}: (${u.toFixed(3)}, ${v.toFixed(3)}) が ${hit} 枚に重なった`);
          if (inset && C.pointInPoly(u, v, inset)) {
            assert.strictEqual(hit, 1,
              `${shape.name} ${diff}: (${u.toFixed(3)}, ${v.toFixed(3)}) がどのセルにも入らない`);
          }
        }
      }
    }
  }
});

test('easy には縁取りを付けない(帯だけで枚数を使い切ってしまう)', () => {
  const shape = C.WINDOW_SHAPES[0];
  const [PW, PH] = SHAPE_PANELS(shape);
  assert.ok(C.DIFF_TARGET.easy < C.BORDER_MIN_TARGET);
  for (let t = 0; t < 6; t++) {
    const withB = C.makeWindow({ diff: 'easy', shapePoly: shape.poly(), symmetric: true,
                                 panelW: PW, panelH: PH, border: true }).length;
    assert.ok(withB <= C.DIFF_TARGET.easy * 1.3 + 6, `easy が ${withB} 枚になった`);
  }
});

test('縁取りを付けても、枚数が大きく落ちない', () => {
  /* 小さい画面の四角窓・丸窓では帯が面積を食う。落ちるなら帯をあきらめる決まり。
     1枚ごとの枚数は割り方の運でぶれるので、平均で見る */
  for (const [PW, PH] of [[256, 414], [300, 484]]) {
    for (const shape of C.WINDOW_SHAPES) {
      const w = shape.ratio >= 1 ? Math.min(PW, PH) : PW, h = w / shape.ratio;
      for (const diff of ['normal', 'hard', 'vhard']) {
        const avg = (border) => {
          let sum = 0;
          for (let i = 0; i < 8; i++) {
            sum += C.makeWindow({ diff, shapePoly: shape.poly(), symmetric: i % 2 === 0,
                                  panelW: w, panelH: h, border }).length;
          }
          return sum / 8;
        };
        const plain = avg(false), bordered = avg(true);
        assert.ok(bordered >= plain * 0.85,
          `${shape.name} ${diff} ${PW}x${PH}: 縁なし 平均 ${plain.toFixed(0)} 枚 → ` +
          `縁あり 平均 ${bordered.toFixed(0)} 枚 は落ちすぎ`);
      }
    }
  }
});

/* ---------- 曲線の鉛線 ---------- */

test('T字をそろえると、内側の辺はすべて2枚で共有される', () => {
  const at = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  const edgeKey = (a, b) => (at(a) < at(b) ? at(a) + '|' + at(b) : at(b) + '|' + at(a));
  const shape = C.WINDOW_SHAPES[0];
  for (const diff of ['normal', 'vhard']) {
    const raw = C.makeWindow({ diff, shapePoly: shape.poly(), symmetric: true,
                               panelW: 325, panelH: 525, border: true });
    const conformed = C.conformCells(raw, 325, 525);
    const count = (cells) => {
      const m = new Map();
      for (const c of cells) {
        for (let i = 0; i < c.length; i++) m.set(edgeKey(c[i], c[(i + 1) % c.length]),
          (m.get(edgeKey(c[i], c[(i + 1) % c.length])) || 0) + 1);
      }
      let shared = 0;
      for (const n of m.values()) if (n >= 2) shared++;
      return shared / m.size;
    };
    assert.ok(count(conformed) > 0.8,
      `${diff}: そろえた後も共有されている辺が ${(count(conformed) * 100).toFixed(0)}% しかない`);
    assert.ok(count(conformed) > count(raw), `${diff}: そろえた意味がない`);
    assert.ok(Math.abs(sumArea(conformed) - sumArea(raw)) < 1e-9, `${diff}: 面積が変わった`);
  }
});

test('弧のふくらみは、指定したぶんになる', () => {
  const a = [0.2, 0.5], b = [0.8, 0.5];
  const pts = C.bowPoints(a, b, 10, 5, 300, 300);
  assert.strictEqual(pts.length, 5);
  const mid = pts[2];                         /* 真ん中の点 */
  assert.ok(Math.abs(Math.abs(mid[1] - 0.5) * 300 - 10) < 0.6,
    `ふくらみが 10px にならない (${(Math.abs(mid[1] - 0.5) * 300).toFixed(1)}px)`);
  /* 反対向きも同じだけふくらむ */
  const back = C.bowPoints(a, b, -10, 5, 300, 300);
  assert.ok(Math.abs(back[2][1] - 0.5 + (mid[1] - 0.5)) < 1e-9, '向きで大きさが変わる');
});

test('鉛線を曲げても、窓は隙間なく重なりなく埋まる', () => {
  for (const shape of C.WINDOW_SHAPES) {
    const poly = C.cleanPoly(shape.poly());
    const [PW, PH] = SHAPE_PANELS(shape);
    const shapeArea = Math.abs(C.polyArea(poly));
    for (const diff of ['normal', 'hard', 'vhard']) {
      for (let t = 0; t < 3; t++) {
        const cells = C.makeWindow({ diff, shapePoly: poly, symmetric: t % 2 === 0,
          panelW: PW, panelH: PH, border: t % 2 === 1, curve: true });
        assert.ok(Math.abs(sumArea(cells) - shapeArea) < 0.002,
          `${shape.name} ${diff}: 面積が合わない (${sumArea(cells).toFixed(4)})`);
        /* 重なりも抜けも許さない。窓の中の点は、必ずちょうど1枚に入る */
        const inset = C.insetConvex(poly, 2, PW, PH);   /* ふち上の点は判定がぶれるので少しだけ内側で見る */
        for (let k = 0; k < 25; k++) {
          const u = Math.random(), v = Math.random();
          if (!C.pointInPoly(u, v, poly)) continue;
          const hit = cells.filter(c => C.pointInPoly(u, v, c)).length;
          assert.ok(hit <= 1, `${shape.name} ${diff}: (${u.toFixed(3)}, ${v.toFixed(3)}) が ${hit} 枚に重なった`);
          if (inset && C.pointInPoly(u, v, inset)) {
            assert.strictEqual(hit, 1,
              `${shape.name} ${diff}: (${u.toFixed(3)}, ${v.toFixed(3)}) がどのセルにも入らない`);
          }
        }
      }
    }
  }
});

test('弧を入れても、セルの形が壊れない(自分の辺どうしが交わらない)', () => {
  /* 細長い三日月のようなセルでは、弧が向かいの辺を突き抜けて重なりが出る。
     実測: この見張りが無い時、40万点中 83 点が2枚のセルに入っていた */
  const selfCrosses = (poly) => {
    for (let i = 0; i < poly.length; i++) {
      for (let j = i + 2; j < poly.length; j++) {
        if (i === 0 && j === poly.length - 1) continue;
        if (C.segmentsCross(poly[i], poly[(i + 1) % poly.length],
                            poly[j], poly[(j + 1) % poly.length])) return true;
      }
    }
    return false;
  };
  for (const shape of C.WINDOW_SHAPES) {
    const poly = C.cleanPoly(shape.poly());
    const [PW, PH] = SHAPE_PANELS(shape);
    for (const diff of ['normal', 'hard', 'vhard']) {
      for (let t = 0; t < 3; t++) {
        const cells = C.makeWindow({ diff, shapePoly: poly, symmetric: t % 2 === 0,
          panelW: PW, panelH: PH, border: t % 2 === 1, curve: true });
        for (const cell of cells) {
          assert.ok(!selfCrosses(cell),
            `${shape.name} ${diff}: 自分の辺どうしが交わるセル (${cell.length}点)`);
        }
      }
    }
  }
});

test('向かいの辺を突き抜ける弧は入れない', () => {
  /* 細長いセル: (0,0)-(1,0)-(1,0.02)-(0,0.02) を横切る弧は入らない */
  const thin = [[0, 0], [1, 0], [1, 0.02], [0, 0.02]];
  const deep = C.bowPoints([0, 0], [1, 0], 40, 4, 300, 300);    /* 大きくふくらませる */
  assert.strictEqual(C.bowFits(thin, 0, deep), false, '突き抜ける弧を通してしまう');
  const shallow = C.bowPoints([0, 0], [1, 0], -1, 4, 300, 300); /* 外向きに少しだけ */
  assert.strictEqual(C.bowFits(thin, 0, shallow), true, '入るはずの弧をはじいている');
});

test('窓の表情は3種類あり、割合の合計は1になる', () => {
  assert.strictEqual(C.CURVE_STYLES.length, 3);
  const sum = C.CURVE_STYLES.reduce((a, s) => a + s.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `割合の合計が ${sum}`);
  for (const s of C.CURVE_STYLES) {
    assert.ok(s.weight > 0 && s.weight < 1, `${s.name}: 割合が変`);
    assert.ok(s.chance >= 0 && s.chance <= 1, `${s.name}: 曲げる割合が変`);
    assert.ok(s.bow >= 0 && s.bow < 0.5, `${s.name}: ふくらみが変`);
  }
  assert.ok(C.CURVE_STYLES.some(s => s.chance === 0), 'まっすぐな窓が出ない');
  assert.ok(C.CURVE_STYLES.some(s => s.chance === 1), '曲線多めの窓が出ない');
});

test('表情の抽選は、決めた割合どおりになる', () => {
  const counts = {};
  for (let i = 0; i < 10000; i++) {
    const name = C.pickCurveStyle().name;
    counts[name] = (counts[name] || 0) + 1;
  }
  for (const s of C.CURVE_STYLES) {
    const got = (counts[s.name] || 0) / 10000;
    assert.ok(Math.abs(got - s.weight) < 0.03,
      `${s.name}: ${(got * 100).toFixed(1)}% (決めたのは ${(s.weight * 100).toFixed(0)}%)`);
  }
  /* 端の値でも、ちゃんと最初と最後を引ける */
  assert.strictEqual(C.pickCurveStyle(() => 0).name, C.CURVE_STYLES[0].name);
  assert.strictEqual(C.pickCurveStyle(() => 0.999999).name, C.CURVE_STYLES[2].name);
});

test('「曲げる割合 0」なら、鉛線は1本も曲がらない', () => {
  const shape = C.WINDOW_SHAPES[0];
  const [PW, PH] = SHAPE_PANELS(shape);
  const points = (cells) => cells.reduce((a, c) => a + c.length, 0);
  for (let t = 0; t < 4; t++) {
    const flat = C.conformCells(C.makeWindow({ diff: 'hard', shapePoly: shape.poly(),
      symmetric: t % 2 === 0, panelW: PW, panelH: PH, border: true }), PW, PH);

    const straight = C.curveLeading(flat, { panelW: PW, panelH: PH, chance: 0, bow: 0 });
    assert.deepStrictEqual(straight, flat, '曲げないはずが、形が変わっている');

    const flowing = C.curveLeading(flat, { panelW: PW, panelH: PH, chance: 1, bow: 0.16 });
    assert.ok(points(flowing) > points(flat), '曲線多めなのに、弧が入っていない');
  }
  /* 表情の表にも、曲げない窓と曲線多めの窓がある */
  assert.ok(C.CURVE_STYLES.some(s => s.chance === 0) && C.CURVE_STYLES.some(s => s.chance === 1));
});

test('曲げても、硝子は窓の外へはみ出さない', () => {
  /* 窓のふちの辺を曲げると外へふくらむ。切り抜きで出た細片は同じ辺を2回持つので、
     「2枚が共有している」と見えてしまう。別のセルどうしかどうかまで見る */
  const distToBoundary = (p, poly) => {
    let d = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const l2 = ex * ex + ey * ey || 1e-18;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / l2));
      d = Math.min(d, Math.hypot(p[0] - (a[0] + ex * t), p[1] - (a[1] + ey * t)));
    }
    return d;
  };
  for (const shape of C.WINDOW_SHAPES) {
    const poly = C.cleanPoly(shape.poly());
    const [PW, PH] = SHAPE_PANELS(shape);
    for (let t = 0; t < 4; t++) {
      const cells = C.makeWindow({ diff: 'hard', shapePoly: poly, symmetric: t % 2 === 0,
        panelW: PW, panelH: PH, border: t % 2 === 1, curve: true, curveChance: 1, curveBow: 0.16 });
      for (const cell of cells) {
        for (const p of cell) {
          if (C.pointInPoly(p[0], p[1], poly)) continue;
          assert.ok(distToBoundary(p, poly) * PW < 0.05,
            `${shape.name}: 窓の外に ${(distToBoundary(p, poly) * PW).toFixed(2)}px はみ出した`);
        }
      }
    }
  }
});

test('左右対称の窓は、曲げても左右対称のまま', () => {
  /* 曲げる/曲げないの判断を片側だけで決めると、ここで崩れる */
  for (const shape of C.WINDOW_SHAPES) {
    const [PW, PH] = SHAPE_PANELS(shape);
    for (let t = 0; t < 4; t++) {
      const cells = C.makeWindow({ diff: 'normal', shapePoly: shape.poly(), symmetric: true,
        panelW: PW, panelH: PH, border: t % 2 === 0, curve: true });
      assert.ok(sameCells(cells, cells.map(c => c.map(p => [1 - p[0], p[1]]))),
        `${shape.name}: 左右対称が崩れた`);
    }
  }
});

test('縁取りの帯は曲げない(まっすぐな縁のまま)', () => {
  const shape = C.WINDOW_SHAPES[0];
  const [PW, PH] = SHAPE_PANELS(shape);
  const plan = C.borderPlan('vhard', PW, PH);
  const ring = C.ringCells(C.cleanPoly(shape.poly()),
                           C.insetConvex(C.cleanPoly(shape.poly()), plan.band, PW, PH),
                           plan.pieceLen, PW, PH);
  const cells = C.makeWindow({ diff: 'vhard', shapePoly: shape.poly(), symmetric: true,
    panelW: PW, panelH: PH, border: true, curve: true });
  /* 帯は先頭に並ぶ。T字をそろえた点が増えるので枚数では見ず、
     「どの点も元の帯の枠線の上にある」= 曲げられていない、で見る */
  const distToEdge = (p, a, b) => {
    const ax = a[0] * PW, ay = a[1] * PH, bx = b[0] * PW, by = b[1] * PH;
    const px = p[0] * PW, py = p[1] * PH;
    const ex = bx - ax, ey = by - ay;
    const len2 = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / len2));
    return Math.hypot(px - (ax + ex * t), py - (ay + ey * t));
  };
  let off = 0;
  for (let i = 0; i < ring.length && i < cells.length; i++) {
    for (const p of cells[i]) {
      let d = Infinity;
      for (let k = 0; k < ring[i].length; k++) {
        d = Math.min(d, distToEdge(p, ring[i][k], ring[i][(k + 1) % ring[i].length]));
      }
      if (d > 0.3) off++;
    }
  }
  assert.strictEqual(off, 0, `帯の点が ${off} 個、まっすぐな縁から外れている`);
});

test('曲げても、押せる大きさのセルが痩せない', () => {
  /* もともと細いセルの辺は曲げない、という決まりの見張り */
  const shape = C.WINDOW_SHAPES[0];
  const [PW, PH] = SHAPE_PANELS(shape);
  const smallest = (curve) => {
    let min = Infinity;
    for (let t = 0; t < 8; t++) {
      for (const cell of C.makeWindow({ diff: 'vhard', shapePoly: shape.poly(), symmetric: t % 2 === 0,
        panelW: PW, panelH: PH, border: true, curve })) {
        min = Math.min(min, Math.abs(C.polyArea(cell)) * PW * PH);
      }
    }
    return min;
  };
  const plain = smallest(false), curved = smallest(true);
  assert.ok(curved > plain * 0.75,
    `曲げるといちばん小さいセルが ${plain.toFixed(0)}px² → ${curved.toFixed(0)}px² に痩せる`);
});

/* ---------- 手作り枠 ---------- */

test('手作り枠は、どの細かさでも窓を埋め尽くす', () => {
  assert.ok(C.HANDMADE.length >= 10, `手作り枠が ${C.HANDMADE.length} 種しかない`);
  for (const frame of C.HANDMADE) {
    for (const diff of DIFFS) {
      const cells = frame.build(C.DIFF_TARGET[diff]);
      assert.ok(cells.length >= 4, `${frame.name} (${diff}): ${cells.length} 枚しかない`);
      assert.ok(Math.abs(sumArea(cells) - 1) < 0.01,
        `${frame.name} (${diff}): 面積の合計が ${sumArea(cells).toFixed(4)}(隙間か重なりがある)`);
      for (const cell of cells) {
        assert.ok(cell.length >= 3, `${frame.name} (${diff}): 頂点が足りないセル`);
        assert.ok(inUnit(cell), `${frame.name} (${diff}): 窓からはみ出すセル`);
        assert.ok(Math.abs(C.polyArea(cell)) > 1e-5, `${frame.name} (${diff}): つぶれたセル`);
      }
    }
  }
});

test('手作り枠は、目標の枚数に合わせて細かさが変わる', () => {
  /* 同じ難易度を選んだのに手応えが別物にならないための、いちばんの要 */
  for (const frame of C.HANDMADE) {
    let prev = 0;
    for (const diff of DIFFS) {
      const n = frame.build(C.DIFF_TARGET[diff]).length;
      assert.ok(n >= prev, `${frame.name}: ${diff} で枚数が減った (${prev} → ${n})`);
      prev = n;
    }
    /* どの枠も、どこかの難易度には出せること */
    const at = DIFFS.filter(d => C.HANDMADE_BY_DIFF[d].includes(frame.name));
    assert.ok(at.length > 0, `${frame.name}: どの難易度にも出せない`);

    /* 端から端まで出る枠は、はっきり差が出ること。
       敷き詰めの文様 (麻の葉・亀甲) は、指で押せる細かさに天井と床があるので
       全部の段には出ない。その枠は、出る段のあいだで帯に収まっていればよい
       (「難易度に混ぜる手作り枠の表が…」のテストが見ている) */
    if (at.includes('easy') && at.includes('vhard')) {
      const easy = frame.build(C.DIFF_TARGET.easy).length;
      const vhard = frame.build(C.DIFF_TARGET.vhard).length;
      assert.ok(vhard >= easy * 3,
        `${frame.name}: easy ${easy} 枚 → vhard ${vhard} 枚 では差が小さい`);
    }
  }
});

test('敷き詰めの文様は、隙間なく噛み合い、どのセルも押せる', () => {
  /* 麻の葉・亀甲は「分割」ではなく「敷き詰め」。同じ形が繰り返し噛み合う。
     格子を窓の幅・高さで割り切っているので、縁に欠けらが残らない */
  for (const name of ['Hemp Leaf', 'Tortoiseshell', 'Basket Weave',
                      'Linked Octagons', 'Rising Steam']) {
    const frame = C.HANDMADE.find(f => f.name === name);
    assert.ok(frame, `${name} が無い`);
    /* 敷き詰めは押せる細かさが飛び飛びなので、全部の段には出ない。
       籠目はいちばん狭くて normal と hard の2段だけ。
       段ごとの品ぞろえは「どの段にも、実在の文様が二つ以上出る」で見る */
    const at = DIFFS.filter(d => C.HANDMADE_BY_DIFF[d].includes(name));
    assert.ok(at.length >= 2, `${frame.jp}: 出せる段が ${at.length} しかない`);
    for (const diff of at) {
      const cells = frame.build(C.DIFF_TARGET[diff]);
      assert.ok(Math.abs(sumArea(cells) - 1) < 1e-9,
        `${frame.jp} (${diff}): 面積の合計が ${sumArea(cells).toFixed(6)}`);
      for (const cell of cells) {
        const b = bbox(cell);
        const w = (b.u1 - b.u0) * C.FIT_PANEL.w, h = (b.v1 - b.v0) * C.FIT_PANEL.h;
        assert.ok(Math.min(w, h) >= C.TAP_MIN_PX,
          `${frame.jp} (${diff}): ${w.toFixed(1)}x${h.toFixed(1)}px の欠けらが残った`);
      }
      /* 適当な点をとると、必ずちょうど1枚に入る(隙間も重なりも無い) */
      for (let k = 0; k < 40; k++) {
        const u = Math.random(), v = Math.random();
        const hit = cells.filter(c => C.pointInPoly(u, v, c)).length;
        assert.strictEqual(hit, 1,
          `${frame.jp} (${diff}): (${u.toFixed(3)}, ${v.toFixed(3)}) が ${hit} 枚に入った`);
      }
    }
  }
});

test('どの段にも、実在の文様が二つ以上出る', () => {
  const woven = ['Hemp Leaf', 'Tortoiseshell', 'Basket Weave',
                 'Linked Octagons', 'Rising Steam'];
  for (const diff of DIFFS) {
    const pool = C.HANDMADE_BY_DIFF[diff].filter(n => woven.includes(n));
    assert.ok(pool.length >= 2,
      `${diff}: 敷き詰めの文様が ${pool.length} つしか出ない`);
  }
});

test('難易度に混ぜる手作り枠の表が、条件と食い違っていない', () => {
  /* 表は手で書いてある。枠を足したり形を変えたら、ここで気づける */
  for (const diff of DIFFS) {
    const listed = new Set(C.HANDMADE_BY_DIFF[diff]);
    for (const frame of C.HANDMADE) {
      const fits = C.fitsDifficulty(frame, diff);
      assert.strictEqual(listed.has(frame.name), fits,
        fits
          ? `${diff} に ${frame.name} を入れ忘れている`
          : `${diff} の ${frame.name} は条件を満たしていないのに表に載っている`);
    }
    assert.ok(listed.size >= 4, `${diff}: 混ざる手作り枠が ${listed.size} 種しかない`);
  }
});

test('手作り枠も、指で押せる大きさに収まっている', () => {
  for (const diff of DIFFS) {
    for (const name of C.HANDMADE_BY_DIFF[diff]) {
      const frame = C.HANDMADE.find(f => f.name === name);
      for (const cell of frame.build(C.DIFF_TARGET[diff])) {
        const b = bbox(cell);
        const w = (b.u1 - b.u0) * C.FIT_PANEL.w, h = (b.v1 - b.v0) * C.FIT_PANEL.h;
        assert.ok(Math.min(w, h) >= C.TAP_MIN_PX,
          `${name} (${diff}): ${Math.min(w, h).toFixed(1)}px のセルがある`);
      }
    }
  }
});

test('難易度ごとの手作り枠は、実在する枠を指している', () => {
  const names = new Set(C.HANDMADE.map(f => f.name));
  for (const [diff, pool] of Object.entries(C.HANDMADE_BY_DIFF)) {
    assert.ok(DIFFS.includes(diff), `知らない難易度: ${diff}`);
    for (const name of pool) {
      assert.ok(names.has(name), `${diff} が知らない枠を指している: ${name}`);
    }
  }
});

/* ---------- しまう・取り出す ---------- */

const sampleWindow = () => ({
  diff: 'normal', ratio: 0.62, shape: 'gothic', handmade: null,
  familyIdx: 6, completed: false,
  cells: [C.rectCell(0, 0, 1, 0.5), C.rectCell(0, 0.5, 1, 1)],
  fills: ['#1440c8', null],
});
/* 保存を通したのと同じ道を通す(文字列にして戻す) */
const roundTrip = (win) => C.unpackWindow(JSON.parse(JSON.stringify(C.packWindow(win))));

test('しまった窓は、そのまま取り出せる', () => {
  const win = sampleWindow();
  const back = roundTrip(win);
  assert.ok(back);
  assert.strictEqual(back.diff, win.diff);
  assert.strictEqual(back.shape, win.shape);
  assert.strictEqual(back.familyIdx, win.familyIdx);
  assert.deepStrictEqual(back.fills, win.fills);
  assert.strictEqual(back.cells.length, win.cells.length);
  for (let i = 0; i < win.cells.length; i++) {
    for (let k = 0; k < win.cells[i].length; k++) {
      assert.ok(Math.abs(back.cells[i][k][0] - win.cells[i][k][0]) < 1e-4);
      assert.ok(Math.abs(back.cells[i][k][1] - win.cells[i][k][1]) < 1e-4);
    }
  }
});

test('手作り枠の窓も、そのまま取り出せる', () => {
  const win = { ...sampleWindow(), shape: null, handmade: 'Checker' };
  assert.strictEqual(roundTrip(win).handmade, 'Checker');
});

test('vhard の窓を丸ごとしまっても、収まる大きさで済む', () => {
  const PW = 300, PH = 484;
  const cells = C.randomFrame('vhard', PW / PH, false, PW, PH);
  const text = JSON.stringify(C.packWindow({
    diff: 'vhard', ratio: PW / PH, shape: 'rect', handmade: null, familyIdx: 0,
    completed: false, cells, fills: cells.map(() => '#1440c8'),
  }));
  assert.ok(text.length < 200 * 1024, `${(text.length / 1024).toFixed(0)}KB は大きすぎる`);
});

test('壊れた中身を読んでも、落ちずに null を返す', () => {
  const good = C.packWindow(sampleWindow());
  const broken = [
    null, undefined, 'ごみ', 42, {}, { ...good, v: 999 },
    { ...good, cells: [] },                          /* 中身なし */
    { ...good, fills: ['#1440c8'] },                 /* 枚数が合わない */
    { ...good, cells: [[[0, 0], [1, 0]]] },          /* 頂点が足りない */
    { ...good, cells: [[[0, 0], [1, 0], [NaN, 1]]], fills: [null] },
    { ...good, fills: ['red', null] },               /* 色の書き方が違う */
    { ...good, diff: 'impossible' },                 /* 知らない難易度 */
    { ...good, shape: 'triangle' },                  /* 知らない外形 */
    { ...good, handmade: '知らない枠', shape: null },
    { ...good, ratio: 0 },
  ];
  for (const data of broken) {
    assert.strictEqual(C.unpackWindow(data), null, `これを弾けていない: ${String(JSON.stringify(data)).slice(0, 60)}`);
  }
});

test('色の選択がおかしい時は、落とさず既定に戻す', () => {
  const back = C.unpackWindow({ ...C.packWindow(sampleWindow()), familyIdx: 999 });
  assert.ok(back && back.familyIdx === 0);
});

test('埋まっていないのに「完成」と書かれていたら、信じない', () => {
  const win = { ...sampleWindow(), completed: true };   /* fills に null が残っている */
  assert.strictEqual(roundTrip(win).completed, false);
});

/* ---------- 色 ---------- */

test('色は20系統、それぞれ4つの濃淡を持つ', () => {
  assert.strictEqual(C.COLOR_FAMILIES.length, 20);
  const names = new Set();
  for (const fam of C.COLOR_FAMILIES) {
    assert.ok(fam.name, '名前のない色');
    assert.ok(!names.has(fam.name), `色の名前が重複: ${fam.name}`);
    names.add(fam.name);
    assert.strictEqual(fam.shades.length, 4, `${fam.name}: 濃淡が4つでない`);
    for (const s of fam.shades) {
      assert.match(s, /^#[0-9a-f]{6}$/, `${fam.name}: 色の書き方が違う (${s})`);
    }
    assert.ok(Number.isInteger(fam.at) && fam.at >= 0, `${fam.name}: 仕入れる窓数が変`);
  }
});

/* ---------- 言葉づかい ---------- */

test('窓と枠には、和名(銘)と欧文の両方がある', () => {
  /* 決めごと: 読んで決める言葉は日本語、銘として眺める言葉は欧文。
     銘は「漢字の和名 + 小さな欧文」の二枚組で出す */
  const kana = /^[ぁ-んァ-ヶ一-龠々ー]+$/;
  const latin = /^[A-Za-z ]+$/;
  for (const f of [...C.WINDOW_SHAPES, ...C.HANDMADE]) {
    assert.ok(f.jp && kana.test(f.jp), `${f.name}: 和名が無いか、日本語でない (${f.jp})`);
    assert.ok(latin.test(f.name), `${f.jp}: 欧文の銘が欧文でない (${f.name})`);
  }
  const jps = [...C.WINDOW_SHAPES, ...C.HANDMADE].map(f => f.jp);
  assert.strictEqual(new Set(jps).size, jps.length, '和名が重複している');
});

test('硝子と木枠の名は、すべて日本語', () => {
  const kana = /^[ぁ-んァ-ヶ一-龠々ー]+$/;
  for (const f of C.COLOR_FAMILIES) {
    assert.ok(kana.test(f.name), `硝子の名が日本語でない: ${f.name}`);
  }
  for (const f of C.FRAMES) {
    assert.ok(kana.test(f.name), `木枠の名が日本語でない: ${f.name}`);
  }
});

/* ---------- 硝子棚 ---------- */

test('最初から持っている色は、今までと同じ10系統', () => {
  const open = C.unlockedColors(0);
  assert.strictEqual(open.length, 10, '最初に持っている色が10系統でない');
  assert.deepStrictEqual(open.map(f => f.name),
    ['紅', '橙', '金', '若草', '翠', '浅葱', '瑠璃', '菫', '桃', '乳白'],
    '前からあった色が減っている(持っていた物は取り上げない)');
  assert.strictEqual(C.unlockedFrames(0).length, 1, '最初の木枠は1種');
});

test('棚は増えるだけで、減らない', () => {
  let prevC = 0, prevF = 0;
  for (let n = 0; n <= 40; n++) {
    const c = C.unlockedColors(n).length, f = C.unlockedFrames(n).length;
    assert.ok(c >= prevC, `${n}窓で色が減った (${prevC} → ${c})`);
    assert.ok(f >= prevF, `${n}窓で木枠が減った (${prevF} → ${f})`);
    prevC = c; prevF = f;
  }
  assert.strictEqual(prevC, C.COLOR_FAMILIES.length, '40窓で色がそろわない');
  assert.strictEqual(prevF, C.FRAMES.length, '40窓で木枠がそろわない');
});

test('つぎに増える物は、いちばん近い一つ', () => {
  assert.strictEqual(C.nextUnlock(0).name, '臙脂');
  assert.strictEqual(C.nextUnlock(0).left, 1);
  const all = [...C.COLOR_FAMILIES, ...C.FRAMES].map(f => f.at).filter(n => n > 0);
  const last = Math.max(...all);
  assert.strictEqual(C.nextUnlock(last), null, 'そろっても「つぎ」が出る');
  /* どこで見ても、つぎの物は必ず未来にある */
  for (let n = 0; n < last; n++) {
    const u = C.nextUnlock(n);
    assert.ok(u && u.at > n && u.left === u.at - n, `${n}窓での「つぎ」がおかしい`);
  }
});

test('増えた物の知らせは、その回に増えた分だけ', () => {
  assert.deepStrictEqual(C.newlyUnlocked(0, 1).map(g => g.name), ['臙脂']);
  assert.deepStrictEqual(C.newlyUnlocked(1, 1), [], '増えていないのに知らせる');
  /* 1窓ずつ数えた合計が、まとめて数えた物と同じ */
  const one = [];
  for (let n = 0; n < 40; n++) one.push(...C.newlyUnlocked(n, n + 1).map(g => g.name));
  const all = C.newlyUnlocked(0, 40).map(g => g.name);
  assert.deepStrictEqual([...one].sort(), [...all].sort(), '取りこぼしか、二重に知らせている');
  assert.strictEqual(all.length,
    C.COLOR_FAMILIES.length - 10 + C.FRAMES.length - 1, '増える物の数が合わない');
});

test('木枠はどれも、3段の木目と縁の色を持つ', () => {
  const keys = new Set();
  for (const f of C.FRAMES) {
    assert.ok(f.key && !keys.has(f.key), `木枠の key が重複: ${f.key}`);
    keys.add(f.key);
    assert.ok(f.name, '名前のない木枠');
    assert.strictEqual(f.wood.length, 3, `${f.name}: 木目が3段でない`);
    for (const c of f.wood) assert.match(c, /^#[0-9a-f]{6}$/, `${f.name}: 色の書き方が違う`);
    assert.match(f.edge, /^rgba\(/, `${f.name}: 縁の色が rgba でない`);
    assert.ok(Number.isInteger(f.at) && f.at >= 0, `${f.name}: 仕入れる窓数が変`);
  }
});
