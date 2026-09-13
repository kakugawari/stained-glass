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

const DIFFS = ['easy', 'normal', 'hard', 'vhard'];
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
  assert.ok(avg.easy < avg.normal && avg.normal < avg.hard && avg.hard < avg.vhard,
    `枚数が難易度順に増えていない: ${JSON.stringify(avg)}`);
});

test('対称モードは左右対称になる', () => {
  const key = (cells) => cells.map(c => {
    let cx = 0, cy = 0;
    for (const p of c) { cx += p[0]; cy += p[1]; }
    return `${(cx / c.length).toFixed(6)},${(cy / c.length).toFixed(6)}`;
  }).sort().join('|');

  for (let t = 0; t < 10; t++) {
    const cells = C.randomFrame('normal', 0.62, true, 300, 484);
    const mirrored = cells.map(c => c.map(p => [1 - p[0], p[1]]));
    assert.strictEqual(key(cells), key(mirrored), '鏡写しにならない');
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

/* ---------- 手作り枠 ---------- */

test('手作り枠10種は、どの細かさでも窓を埋め尽くす', () => {
  assert.strictEqual(C.HANDMADE.length, 10);
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
    /* easy と vhard で、はっきり差が出ること */
    const easy = frame.build(C.DIFF_TARGET.easy).length;
    const vhard = frame.build(C.DIFF_TARGET.vhard).length;
    assert.ok(vhard >= easy * 3, `${frame.name}: easy ${easy} 枚 → vhard ${vhard} 枚 では差が小さい`);
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

test('色は10系統、それぞれ4つの濃淡を持つ', () => {
  assert.strictEqual(C.COLOR_FAMILIES.length, 10);
  const names = new Set();
  for (const fam of C.COLOR_FAMILIES) {
    assert.ok(fam.name, '名前のない色');
    assert.ok(!names.has(fam.name), `色の名前が重複: ${fam.name}`);
    names.add(fam.name);
    assert.strictEqual(fam.shades.length, 4, `${fam.name}: 濃淡が4つでない`);
    for (const s of fam.shades) {
      assert.match(s, /^#[0-9a-f]{6}$/, `${fam.name}: 色の書き方が違う (${s})`);
    }
  }
});
