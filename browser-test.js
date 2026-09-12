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
    await phone.waitForFunction(() => window.__app && window.__app.state().cells.length > 0);
    ok(true, 'ページが開いて、窓が組み上がる');

    const fit = await phone.evaluate(() => ({
      wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tall: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      title: document.getElementById('title').textContent.trim()
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
    ok(after.fills.filter((f) => f !== null).length === 1, '押していないセルは空のまま');

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

    // ------------------------------------------------ 難易度
    section('難易度');
    const counts = {};
    for (const [key, id] of [['easy', 'btn-easy'], ['normal', 'btn-normal'],
                             ['hard', 'btn-hard'], ['vhard', 'btn-vhard']]) {
      await phone.locator('#' + id).tap();
      await phone.waitForTimeout(80);
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

    // ------------------------------------------------ 埋めきる
    section('埋めきる');
    await phone.locator('#btn-easy').tap();
    await phone.waitForTimeout(80);
    const easy = await state(phone);
    for (let i = 0; i < easy.cells.length; i++) await tapCell(phone, i);
    const done = await state(phone);
    ok(done.remain === 0 && done.completed, `全部埋めると完成になる (${easy.cells.length} 枚)`);
    ok(await phone.evaluate(() => document.getElementById('remain').classList.contains('hidden')),
      '完成するとのこり枚数の表示が消える');

    // ふちにかけらが出る窓(丸窓・アーチ・ゴシック)でも、押すだけで完成するか
    let withSlivers = null;
    for (let t = 0; t < 30 && !withSlivers; t++) {
      await phone.locator('#btn-hard').tap();
      await phone.waitForTimeout(60);
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
    await phone.setViewportSize({ width: 844, height: 390 });
    await phone.waitForTimeout(200);
    const land = await state(phone);
    const v = phone.viewportSize();
    ok(land.panel.x >= 0 && land.panel.y >= 0 &&
       land.panel.x + land.panel.w <= v.width && land.panel.y + land.panel.h <= v.height,
      '横向きにしても窓が画面からはみ出さない');
    ok(land.fills.filter((f) => f !== null).length === land.cells.length,
      '向きを変えても、嵌めた硝子が消えない');
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
    const marker = '<div id="title">';
    const head = original.indexOf(marker) + marker.length;
    const tail = original.indexOf('</div>', head);
    fs.writeFileSync(indexPath,
      original.slice(0, head) + 'こうしんかくにん' + original.slice(tail));
    let shown;
    try {
      await swPage.reload();
      await swPage.waitForTimeout(400);
      shown = (await swPage.textContent('#title')).trim();
    } finally {
      fs.writeFileSync(indexPath, original);
    }
    ok(shown === 'こうしんかくにん', `直したものが 1 回のリロードで出る (${shown})`);

    // 元に戻したものも、1 回のリロードで戻る
    await swPage.reload();
    await swPage.waitForTimeout(400);
    ok((await swPage.textContent('#title')).trim() === 'Light the Glass',
      '元に戻したものも 1 回のリロードで戻る');

    // つながらなくても遊べるか
    await swPage.waitForTimeout(500);
    await swCtx.setOffline(true);
    await swPage.reload().catch(() => {});
    await swPage.waitForTimeout(500);
    ok(await swPage.evaluate(() => !!(window.__app && window.__app.state().cells.length)).catch(() => false),
      'ネットにつながらなくても開けて、窓が組み上がる');
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
