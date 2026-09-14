/*
 * ブラウザで実際に動かして確かめるテスト。
 *
 *   npm i -D playwright && npm run test:ui
 *
 * 画面まわりの不具合は node のテストでは捕まらない。ここでは本物の
 * ブラウザ(iPhone の画面サイズ)を立ち上げ、指の操作をそのまま再現する。
 *
 * 直した不具合には、かならず見張り役をここに置くこと。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

const PORT = Number(process.env.PORT || 8123);
const URL = `http://localhost:${PORT}/`;
const ROOT = __dirname;
const CHROMIUM = process.env.CHROMIUM_PATH;   // 手元の Chromium を使いたいとき

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + message);
  } else {
    failed++;
    console.log('  \x1b[31m✗ FAIL\x1b[0m ' + message);
  }
}

function section(name) {
  console.log('\n' + name);
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      http.get(URL, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - started > 10000) reject(new Error('サーバーが起動しない'));
          else setTimeout(tick, 100);
        });
    };
    tick();
  });
}

/* タイトル画面で難易度を選び、遊ぶ画面に入る */
async function start(page, diff) {
  if (await page.evaluate(() => window.__app.screen()) === 'play') {
    await page.locator('#to-title').tap();
    await page.waitForTimeout(80);
  }
  await page.locator(`.start-btn[data-diff="${diff}"]`).tap();
  await page.waitForTimeout(120);
  if (await page.evaluate(() => window.__app.asking())) {
    await page.locator('#ask-yes').tap();
    await page.waitForTimeout(150);
  }
  await page.waitForFunction(() => window.__app.screen() === 'play'
    && window.__app.state().cells.length > 0);
}

/* 遊ぶ画面のまま、窓だけ引き直す(アプリ本体と同じ道) */
async function draw(page, diff) {
  await page.evaluate((d) => window.__app.newWindow(d), diff);
  await page.waitForTimeout(60);
}

/* i 番目のセルの真ん中を、指で押す */
async function tapCell(page, i) {
  const at = await page.evaluate((k) => window.__app.cellCenter(k), i);
  await page.touchscreen.tap(at.x, at.y);
  await page.waitForTimeout(60);
  return at;
}

const state = (page) => page.evaluate(() => window.__app.state());

async function run() {
  let chromium;
  let devices;
  try {
    ({ chromium, devices } = require('playwright'));
  } catch (e) {
    console.error('playwright が必要です:  npm i -D playwright');
    process.exit(1);
  }

  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(PORT)], {
    stdio: 'ignore'
  });
  await waitForServer();

  const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const errors = [];

  try {
    // ------------------------------------------------ スマホで開く
    section('スマホで開く');
    const context = await browser.newContext({ ...devices['iPhone 13'] });
    const phone = await context.newPage();
    phone.on('pageerror', (e) => errors.push('スマホ: ' + e.message));
    phone.on('console', (m) => { if (m.type() === 'error') errors.push('スマホ: ' + m.text()); });
    await phone.goto(URL);
    await phone.waitForFunction(() => window.__app);
    ok(await phone.evaluate(() => window.__app.screen()) === 'title', '開くとタイトル画面が出る');
    ok(await phone.evaluate(() => {
      const r = document.getElementById('start-icon').getBoundingClientRect();
      return r.width > 80 && r.height > 80;
    }), 'アイコンが出ている');
    ok(await phone.evaluate(() => document.getElementById('go-resume').hidden),
      'まっさらな時は「つづきから」を出さない');
    ok(await phone.evaluate(() => document.getElementById('bar').hidden),
      'タイトル画面では色の帯を出さない');

    await start(phone, 'normal');
    ok(true, '難易度を選ぶと窓が組み上がる');

    const fit = await phone.evaluate(() => ({
      wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tall: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      title: document.getElementById('start-sub').textContent.trim()
    }));
    ok(fit.wide <= 1, 'スマホ幅で横スクロールが出ない');
    ok(fit.tall <= 1, '縦にもはみ出さない(1画面に収まる)');
    ok(fit.title.length > 0, `題が出ている (${fit.title})`);

    // 窓が画面の中に収まっているか(木枠がはみ出すと欠けて見える)
    const panel = (await state(phone)).panel;
    const size = phone.viewportSize();
    ok(panel.x > 0 && panel.y > 0 &&
       panel.x + panel.w < size.width && panel.y + panel.h < size.height,
      `窓が画面に収まる (${Math.round(panel.w)}x${Math.round(panel.h)}px)`);

    // ------------------------------------------------ 硝子を嵌める
    section('硝子を嵌める');
    const before = await state(phone);
    await tapCell(phone, 0);
    let after = await state(phone);
    ok(after.fills[0] !== null, '押したセルに硝子が嵌まる');
    ok(after.remain === before.remain - 1, `のこり枚数が 1 減る (${before.remain} → ${after.remain})`);
    // 押した所の「持ち主と連れ」だけが嵌まり、他は空のまま
    const host0 = after.hosts[0];
    const group = after.hosts.map((h, i) => (h === host0 ? i : -1)).filter((i) => i >= 0);
    const filledNow = after.fills.map((f, i) => (f !== null ? i : -1)).filter((i) => i >= 0);
    ok(JSON.stringify(filledNow) === JSON.stringify(group),
      `押した1か所ぶんだけが嵌まる (塗れた ${JSON.stringify(filledNow)} / その組 ${JSON.stringify(group)})`);
    ok(new Set(group.map((i) => after.fills[i])).size === 1, '持ち主と連れは同じ硝子になる');

    // 画面の「n left」と中身が合っているか
    const shownRemain = (await phone.textContent('#remain')).trim();
    ok(shownRemain === `${after.remain} left`,
      `のこり枚数の表示と中身が合う (画面「${shownRemain}」/ 中身 ${after.remain})`);

    // 押した場所が、狙ったセルに入っているか(座標のずれよけ)
    const targets = [1, 2, Math.floor(after.cells.length / 2), after.cells.length - 1];
    let hitAll = true;
    for (const i of targets) {
      await tapCell(phone, i);
      const s = await state(phone);
      if (s.fills[i] === null) hitAll = false;
    }
    ok(hitAll, `押した所のセルがちゃんと反応する (${targets.length} か所)`);

    // 同じセルをもう一度押したら、必ず色味が変わる
    const was = (await state(phone)).fills[0];
    await tapCell(phone, 0);
    const now = (await state(phone)).fills[0];
    ok(now !== was, `押し直すと色味が変わる (${was} → ${now})`);

    // 色を選ぶと、その系統の色が嵌まる
    await phone.locator('.swatch').nth(0).tap();   // 紅
    await tapCell(phone, 3);
    const red = (await state(phone)).fills[3];
    const redShades = await phone.evaluate(() => window.Core.COLOR_FAMILIES[0].shades);
    ok(redShades.includes(red), `選んだ色の系統が嵌まる (${red})`);

    // 操作帯が窓にかぶっていないか(かぶると、その下のセルが押せない)
    const overlap = await phone.evaluate(() => {
      const { panel } = window.__app.state();
      return Math.round(panel.y + panel.h - document.getElementById('bar').getBoundingClientRect().top);
    });
    ok(overlap <= 0, `操作帯が窓にかぶらない (すき間 ${-overlap}px)`);

    // ------------------------------------------------ なぞって塗る
    section('なぞって塗る');
    await draw(phone, 'normal');

    // 窓を横切ってなぞると、通った道が塗れる
    const swipe = await phone.evaluate(async () => {
      const cv = document.getElementById('cv');
      const p = window.__app.state().panel;
      const y = p.y + p.h * 0.5;
      const fire = (type, x, yy) =>
        cv.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: yy, bubbles: true }));
      fire('pointerdown', p.x + 4, y);
      for (let i = 1; i <= 10; i++) {
        fire('pointermove', p.x + 4 + (p.w - 8) * i / 10, y);
        await new Promise((r) => setTimeout(r, 12));
      }
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      const s = window.__app.state();
      return { filled: s.fills.filter((f) => f !== null).length, fills: s.fills.slice(),
               sweeping: window.__app.sweeping() };
    });
    ok(swipe.filled >= 4, `なぞった道すじが塗れる (${swipe.filled} 枚)`);
    ok(!swipe.sweeping, '窓の中から始めたなぞりでは、光のはらいにならない');

    // 塗った上をもう一度なぞっても、塗り替わらない(うっかり指がすべっても壊れない)
    const again = await phone.evaluate(async (beforeFills) => {
      const cv = document.getElementById('cv');
      const p = window.__app.state().panel;
      const y = p.y + p.h * 0.5;
      const fire = (type, x, yy) =>
        cv.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: yy, bubbles: true }));
      /* 押した所は「押した」扱いで塗り替わるので、少し内側から始める */
      fire('pointerdown', p.x + p.w * 0.45, y);
      for (let i = 1; i <= 6; i++) {
        fire('pointermove', p.x + p.w * (0.45 + 0.5 * i / 6), y);
        await new Promise((r) => setTimeout(r, 12));
      }
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      const now = window.__app.state().fills;
      let changed = 0;
      for (let i = 0; i < now.length; i++) {
        if (beforeFills[i] !== null && now[i] !== beforeFills[i]) changed++;
      }
      return changed;
    }, swipe.fills);
    ok(again <= 1, `なぞっても、塗ってある硝子は替えない (替わったのは ${again} 枚。押し始めの1枚まで)`);

    // 窓の外から速くはらうと、光だけ走って 1 枚も塗れない
    const flick = await phone.evaluate(async () => {
      const cv = document.getElementById('cv');
      const p = window.__app.state().panel;
      const y = p.y + p.h * 0.4;
      const before = window.__app.state().fills.filter((f) => f !== null).length;
      const fire = (type, x, yy) =>
        cv.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: yy, bubbles: true }));
      fire('pointerdown', p.x - 40, y);
      for (let i = 1; i <= 8; i++) {
        fire('pointermove', p.x - 40 + (p.w + 80) * i / 8, y);
        await new Promise((r) => setTimeout(r, 4));   /* 指より速いくらい */
      }
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 40));
      return { sweeping: window.__app.sweeping(),
               added: window.__app.state().fills.filter((f) => f !== null).length - before };
    });
    ok(flick.sweeping, '窓の外から速くはらうと、光の帯が走る');
    ok(flick.added === 0, 'そのはらいでは硝子が 1 枚も嵌まらない');

    // ------------------------------------------------ 壁の色
    section('壁の色');
    await phone.locator('#to-title').tap();
    await phone.waitForTimeout(150);
    const wallOf = () => phone.evaluate(() => {
      const cv = document.getElementById('cv');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const d = cv.getContext('2d').getImageData(4, 4, 1, 1).data;
      return [d[0], d[1], d[2]];
    });
    ok(await phone.evaluate(() => window.__app.theme()) === 'day', '最初は白い壁');
    const dayWall = await wallOf();
    await phone.locator('#theme-toggle').tap();
    await phone.waitForTimeout(200);
    const nightWall = await wallOf();
    ok(await phone.evaluate(() => window.__app.theme()) === 'night' &&
       nightWall[0] + nightWall[1] + nightWall[2] < dayWall[0] + dayWall[1] + dayWall[2] - 200,
      `押すと暗い部屋になる (rgb(${dayWall}) → rgb(${nightWall}))`);
    await phone.reload();
    await phone.waitForFunction(() => window.__app);
    ok(await phone.evaluate(() => window.__app.theme()) === 'night', '選んだ壁は覚えている');
    await phone.locator('#theme-toggle').tap();
    await phone.waitForTimeout(200);
    ok(await phone.evaluate(() => window.__app.theme()) === 'day', '白い壁に戻せる');
    await phone.locator('#go-resume').tap();
    await phone.waitForTimeout(250);

    // ------------------------------------------------ 塗りかけが消えない
    section('塗りかけが消えない');

    // 閉じて開き直しても続きから
    const kept = await state(phone);
    const keptFilled = kept.fills.filter((f) => f !== null).length;
    await phone.reload();
    await phone.waitForFunction(() => window.__app && window.__app.state().cells.length > 0);
    ok(await phone.evaluate(() => window.__app.screen()) === 'title',
      '開き直すとタイトルから始まる');
    ok(!(await phone.evaluate(() => document.getElementById('go-resume').hidden)),
      '塗りかけがあると「つづきから」が出る');
    ok((await phone.textContent('#resume-note')).includes(String(kept.remain)),
      `「つづきから」にのこり枚数が出る (${(await phone.textContent('#resume-note')).trim()})`);

    await phone.locator('#go-resume').tap();
    await phone.waitForTimeout(250);
    const back = await state(phone);
    ok(await phone.evaluate(() => window.__app.screen()) === 'play' &&
       back.fills.filter((f) => f !== null).length === keptFilled && keptFilled > 0,
      `つづきからで、塗りかけの窓に戻る (${keptFilled} 枚)`);
    let worstGap = 0;
    let sameShape = back.cells.length === kept.cells.length;
    for (let i = 0; sameShape && i < kept.cells.length; i++) {
      if (back.cells[i].length !== kept.cells[i].length) { sameShape = false; break; }
      for (let k = 0; k < kept.cells[i].length; k++) {
        worstGap = Math.max(worstGap,
          Math.abs(back.cells[i][k][0] - kept.cells[i][k][0]),
          Math.abs(back.cells[i][k][1] - kept.cells[i][k][1]));
      }
    }
    ok(sameShape && worstGap < 1e-4,
      `窓の割り方もそのまま戻る (ずれ ${(worstGap * 100).toFixed(4)}% 以内)`);
    ok(back.remain === kept.remain, `のこり枚数もそのまま (${back.remain})`);

    // もどる → タイトル
    await phone.locator('#to-title').tap();
    await phone.waitForTimeout(150);
    ok(await phone.evaluate(() => window.__app.screen()) === 'title', 'もどるでタイトルに戻れる');

    // 塗りかけのままタイトルで難易度を選んだら、黙って消さずに一度聞く
    await phone.locator('.start-btn[data-diff="hard"]').tap();
    await phone.waitForTimeout(100);
    ok(await phone.evaluate(() => window.__app.asking()), '塗りかけを消す前に一度聞く');
    const during = await state(phone);
    ok(JSON.stringify(during.cells) === JSON.stringify(back.cells), '聞いている間は窓を変えない');

    // 「やめる」なら、そのまま
    await phone.locator('#ask-no').tap();
    await phone.waitForTimeout(100);
    const stay = await state(phone);
    ok(!(await phone.evaluate(() => window.__app.asking())) &&
       stay.fills.filter((f) => f !== null).length === keptFilled,
      'やめると、塗りかけはそのまま');

    // 「新しく始める」なら新しい窓で、遊ぶ画面に入る
    await phone.locator('.start-btn[data-diff="hard"]').tap();
    await phone.waitForTimeout(100);
    await phone.locator('#ask-yes').tap();
    await phone.waitForTimeout(200);
    const fresh = await state(phone);
    ok(fresh.fills.every((f) => f === null) && fresh.cells.length > stay.cells.length &&
       await phone.evaluate(() => window.__app.screen()) === 'play',
      `新しく始めると、その難易度の窓になる (${fresh.cells.length} 枚)`);

    // 手つかずの窓なら、いちいち聞かない
    await phone.locator('#to-title').tap();
    await phone.waitForTimeout(120);
    await phone.locator('.start-btn[data-diff="easy"]').tap();
    await phone.waitForTimeout(150);
    ok(!(await phone.evaluate(() => window.__app.asking())) &&
       await phone.evaluate(() => window.__app.screen()) === 'play',
      '手つかずの窓なら、聞かずに始まる');

    // 壊れたものがしまってあっても、落ちずに開ける
    await phone.evaluate(() => localStorage.setItem(window.__app.saveKey, '{壊れている'));
    await phone.reload();
    await phone.waitForFunction(() => window.__app);
    ok(await phone.evaluate(() => window.__app.screen()) === 'title',
      '壊れたものがしまってあっても、普通にタイトルが出る');
    await start(phone, 'normal');

    // ------------------------------------------------ 難易度
    section('難易度');
    const counts = {};
    for (const key of ['easy', 'normal', 'hard', 'vhard']) {
      await draw(phone, key);
      const s = await state(phone);
      counts[key] = s.cells.length;
      ok(s.fills.every((f) => f === null), `${key}: 押すと新しい窓になる`);

      // 押して嵌められるセル(持ち主)が、指で押せる大きさか。
      // 外形で切り抜くと 8px のかけらが出る。それは隣に預けてあるはず
      const tap = await phone.evaluate(() => {
        const { cells, hosts, panel } = window.__app.state();
        let worst = Infinity;
        let orphan = 0;
        for (let i = 0; i < cells.length; i++) {
          if (hosts[i] !== i) { if (hosts[hosts[i]] !== hosts[i]) orphan++; continue; }
          const xs = cells[i].map((p) => p[0]), ys = cells[i].map((p) => p[1]);
          const w = (Math.max(...xs) - Math.min(...xs)) * panel.w;
          const h = (Math.max(...ys) - Math.min(...ys)) * panel.h;
          worst = Math.min(worst, Math.min(w, h));
        }
        return { worst: Math.round(worst), orphan };
      });
      ok(tap.worst >= 18 && tap.orphan === 0,
        `${key}: 押せるセルはどれも ${tap.worst}px 以上(押せないセルは ${tap.orphan} 枚)`);
    }
    ok(counts.easy < counts.normal && counts.normal < counts.hard && counts.hard < counts.vhard,
      `難易度が上がるほど枚数が増える (${JSON.stringify(counts)})`);

    // 同じ難易度を引き直しても、手応えが別物にならないか
    // (以前は normal で 12 枚の窓と 48 枚の窓が出ていた)
    for (const key of ['easy', 'normal', 'hard', 'vhard']) {
      const draws = [];
      for (let i = 0; i < 12; i++) {
        await draw(phone, key);
        const s = await state(phone);
        draws.push(s.hosts.filter((h, k) => h === k).length);
      }
      const target = await phone.evaluate((k) => window.Core.DIFF_TARGET[k], key);
      // 幅は core.test.js の「目標のまわりに収まる」と同じ決まりにする。
      // ランダム枠は菱形割りで一度に5枚増えるので、少ない難易度ほど上に振れる
      const lo = Math.min(...draws), hi = Math.max(...draws);
      const floor = target * 0.6, ceil = target * 1.3 + 6;
      ok(lo >= floor && hi <= ceil,
        `${key}: 12回引いても ${lo}〜${hi} 回で収まる (目安 ${Math.round(floor)}〜${Math.round(ceil)})`);
      // easy は枚数が少ないので、比で見ると1枚の差が大きく響く。枚数の差で見る
      if (target < 20) {
        ok(hi - lo <= 10, `${key}: いちばん多い窓と少ない窓の差が ${hi - lo} 枚 (10枚まで)`);
      } else {
        ok(hi / lo <= 2, `${key}: いちばん多い窓と少ない窓の差が 2 倍以内 (${(hi / lo).toFixed(1)} 倍)`);
      }
    }

    // ------------------------------------------------ 埋めきる
    section('埋めきる');
    await draw(phone, 'easy');
    const easy = await state(phone);
    for (let i = 0; i < easy.cells.length; i++) await tapCell(phone, i);
    const done = await state(phone);
    ok(done.remain === 0 && done.completed, `全部埋めると完成になる (${easy.cells.length} 枚)`);
    ok(await phone.evaluate(() => document.getElementById('remain').classList.contains('hidden')),
      '完成するとのこり枚数の表示が消える');

    // ふちにかけらが出る窓(丸窓・アーチ・ゴシック)でも、押すだけで完成するか
    let withSlivers = null;
    for (let t = 0; t < 30 && !withSlivers; t++) {
      await draw(phone, 'hard');
      const s = await state(phone);
      if (s.hosts.some((h, i) => h !== i)) withSlivers = s;
    }
    if (!withSlivers) {
      ok(false, 'かけらの出る窓が 30 回引いても出ない(仕掛けを確かめられない)');
    } else {
      const hostIdx = withSlivers.hosts
        .map((h, i) => (h === i ? i : -1)).filter((i) => i >= 0);
      for (const i of hostIdx) await tapCell(phone, i);
      const s = await state(phone);
      ok(s.remain === 0 && s.completed && s.fills.every((f) => f !== null),
        `ふちにかけらのある窓 (${withSlivers.cells.length} 枚, うちかけら ` +
        `${withSlivers.cells.length - hostIdx.length} 枚) も、押すだけで完成する`);
    }

    // 完成した窓から次へ行く時は、いちいち聞かない
    await draw(phone, 'easy');
    ok(!(await phone.evaluate(() => window.__app.asking())),
      '完成したあと、次の窓へはそのまま行ける');

    // 完成後も描き続けて止まらないか
    const frames = await phone.evaluate(() => new Promise((resolve) => {
      let n = 0;
      const t0 = performance.now();
      const tick = () => {
        n++;
        if (performance.now() - t0 < 500) requestAnimationFrame(tick);
        else resolve(n);
      };
      requestAnimationFrame(tick);
    }));
    ok(frames > 20, `完成後もなめらかに動き続ける (0.5秒で ${frames} フレーム)`);

    // ------------------------------------------------ 画面をまわす
    section('画面をまわす');
    await phone.evaluate(() => window.__app.fillAll());   // 硝子を嵌めた状態で回す
    await phone.waitForTimeout(100);
    const beforeTurn = (await state(phone)).fills.filter((f) => f !== null).length;
    await phone.setViewportSize({ width: 844, height: 390 });
    await phone.waitForTimeout(200);
    const land = await state(phone);
    const v = phone.viewportSize();
    ok(land.panel.x >= 0 && land.panel.y >= 0 &&
       land.panel.x + land.panel.w <= v.width && land.panel.y + land.panel.h <= v.height,
      '横向きにしても窓が画面からはみ出さない');
    ok(land.fills.filter((f) => f !== null).length === beforeTurn && beforeTurn > 0,
      `向きを変えても、嵌めた硝子が消えない (${beforeTurn} 枚)`);
    await phone.setViewportSize({ width: 390, height: 844 });

    // ------------------------------------------------ アイコン
    section('アイコン');
    const desk = await browser.newPage();
    await desk.goto(URL);
    const apple = await desk.evaluate(() =>
      document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'));
    // iOS は SVG のアイコンを使えない
    ok(apple && apple.endsWith('.png'), `ホーム画面用アイコンが PNG (${apple})`);
    const res = await desk.request.get(URL + apple.replace('./', ''));
    ok(res.ok(), `${apple} が配信される`);
    const manifest = await (await desk.request.get(URL + 'manifest.json')).json();
    ok(manifest.icons.every((i) => i.type === 'image/png'), 'manifest のアイコンも PNG');

    // ------------------------------------------------ 更新とオフライン
    section('更新とオフライン');
    const swCtx = await browser.newContext({ ...devices['iPhone 13'] });
    const swPage = await swCtx.newPage();
    await swPage.goto(URL);
    await swPage.waitForFunction(() => window.__app);
    ok(await swPage.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active).catch(() => false)),
      'サービスワーカーが動く');
    await swPage.waitForTimeout(800);

    // 直したものが 1 回のリロードで出るか (キャッシュ優先だと古い画面が出たまま)
    const indexPath = path.join(ROOT, 'index.html');
    const original = fs.readFileSync(indexPath, 'utf8');
    const marker = '<div id="start-sub">';
    const head = original.indexOf(marker) + marker.length;
    const tail = original.indexOf('</div>', head);
    fs.writeFileSync(indexPath,
      original.slice(0, head) + 'こうしんかくにん' + original.slice(tail));
    let shown;
    try {
      await swPage.reload();
      await swPage.waitForTimeout(400);
      shown = (await swPage.textContent('#start-sub')).trim();
    } finally {
      fs.writeFileSync(indexPath, original);
    }
    ok(shown === 'こうしんかくにん', `直したものが 1 回のリロードで出る (${shown})`);

    // 元に戻したものも、1 回のリロードで戻る
    await swPage.reload();
    await swPage.waitForTimeout(400);
    ok((await swPage.textContent('#start-sub')).trim() === '硝子を嵌めて、窓に光を灯す',
      '元に戻したものも 1 回のリロードで戻る');

    // つながらなくても遊べるか
    await swPage.waitForTimeout(500);
    await swCtx.setOffline(true);
    await swPage.reload().catch(() => {});
    await swPage.waitForTimeout(500);
    ok(await swPage.evaluate(() => !!(window.__app && window.__app.screen() === 'title')).catch(() => false),
      'ネットにつながらなくても開けて、タイトルが出る');
    await swCtx.setOffline(false);

    section('エラー');
    ok(errors.length === 0, errors.length ? '画面のエラー: ' + errors.join(' / ') : 'JS エラーなし');
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
