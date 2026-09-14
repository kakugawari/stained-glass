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

    // 段を5つに増やしたので、小さい画面でも全部が見えて押せるか確かめる
    const small = await browser.newContext({ ...devices['iPhone SE'] });
    const tiny = await small.newPage();
    tiny.on('pageerror', (e) => errors.push('小さい画面: ' + e.message));
    await tiny.goto(URL);
    await tiny.waitForFunction(() => window.__app);
    const btns = await tiny.evaluate(() => {
      const list = [...document.querySelectorAll('.start-btn[data-diff]')];
      const vh = window.innerHeight;
      return list.map((el) => {
        const r = el.getBoundingClientRect();
        return { key: el.dataset.diff, top: r.top, bottom: r.bottom, h: r.height, vh };
      });
    });
    ok(btns.length === 5, `小さい画面にも段が 5 つ出る (${btns.map((b) => b.key).join(' / ')})`);
    const hidden = btns.filter((b) => b.bottom > b.vh || b.top < 0);
    ok(hidden.length === 0,
      `どの段も画面に収まる (いちばん下は ${Math.round(btns[4].bottom)}px / 画面 ${btns[0].vh}px)`);
    ok(btns.every((b) => b.h >= 40),
      `どの段も指で押せる高さ (${Math.round(Math.min(...btns.map((b) => b.h)))}px)`);
    ok(await tiny.evaluate(() =>
      document.documentElement.scrollHeight - document.documentElement.clientHeight <= 1),
      '小さい画面でもタイトルが縦にはみ出さない');

    // 「つづきから」が出ると 6 個になる。いちばん下の段が画面の外へ出ないか
    // (段を5つにした時、iPhone SE で very hard が 8px はみ出していた)
    await tiny.evaluate(() => {
      window.__app.enterPlay('normal');
      window.__app.newWindow('normal');
      const c = window.__app.cellCenter(0);
      window.__app.tapCell(c.x, c.y);
      window.__app.showTitle();
    });
    await tiny.waitForTimeout(150);
    const withResume = await tiny.evaluate(() => {
      const list = [...document.querySelectorAll('.start-btn')].filter((e) => !e.hidden);
      const last = list[list.length - 1].getBoundingClientRect();
      return { n: list.length, bottom: Math.round(last.bottom), vh: window.innerHeight,
               resume: !document.getElementById('go-resume').hidden };
    });
    ok(withResume.resume && withResume.n === 6,
      `塗りかけがあると「つづきから」が増えて ${withResume.n} 個になる`);
    ok(withResume.bottom <= withResume.vh,
      `6個でも、いちばん下の段が画面に収まる (${withResume.bottom}px / 画面 ${withResume.vh}px)`);
    await small.close();

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
    ok(shownRemain === `のこり ${after.remain} 枚`,
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

    // 窓を横切ってなぞると、通った道がもれなく塗れる。
    // 何枚通るかは窓しだいなので、「指が通ったセルはすべて塗れたか」で見る
    const swipe = await phone.evaluate(async () => {
      const cv = document.getElementById('cv');
      const p = window.__app.state().panel;
      const y = p.y + p.h * 0.5;
      /* 外形はアーチや丸窓のこともある。窓の中に入った所から始める
         (窓の外から始めると、それは「光のはらい」になる) */
      let x0 = p.x + 4;
      while (x0 < p.x + p.w && window.__app.cellAtXY(x0, y) < 0) x0 += 1;
      const x1 = p.x + p.w - 4;
      const fire = (type, x, yy) =>
        cv.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: yy, bubbles: true }));
      /* 指が通る道すじと、その中にいた長さ(px)を先に拾っておく。
         角をかすめただけのセルまでは求めない。6px 以上またいだ物を見る */
      const len = new Map();
      const N = 600, step = (x1 - x0) / N;
      for (let i = 0; i <= N; i++) {
        const hit = window.__app.cellAtXY(x0 + step * i, y);
        if (hit >= 0) {
          const h = window.__app.state().hosts[hit];
          len.set(h, (len.get(h) || 0) + step);
        }
      }
      const onPath = new Set([...len].filter(([, L]) => L >= 6).map(([h]) => h));
      fire('pointerdown', x0, y);
      for (let i = 1; i <= 10; i++) {
        fire('pointermove', x0 + (x1 - x0) * i / 10, y);
        await new Promise((r) => setTimeout(r, 12));
      }
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      const s = window.__app.state();
      return { filled: s.fills.filter((f) => f !== null).length, fills: s.fills.slice(),
               onPath: onPath.size,
               missed: [...onPath].filter((h) => s.fills[h] === null).length,
               startedInside: window.__app.cellAtXY(x0, y) >= 0,
               sweeping: window.__app.sweeping() };
    });
    ok(swipe.startedInside, 'このなぞりは窓の中から始まっている(前提の確認)');
    ok(swipe.onPath >= 3 && swipe.missed === 0,
      `なぞった道すじが、もれなく塗れる (6px 以上またいだ ${swipe.onPath} 枚 / ` +
      `塗り残し ${swipe.missed} 枚)`);
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

    // ------------------------------------------------ 言葉づかい
    section('言葉づかい');
    // 難易度は「読んで決める言葉」。日本語で出ているか
    const menu = await phone.evaluate(() => {
      window.__app.showTitle();
      return [...document.querySelectorAll('.start-btn[data-diff]')].map((el) => ({
        key: el.dataset.diff,
        name: el.querySelector('.name').textContent.trim(),
        note: el.querySelector('.note').textContent.trim(),
      }));
    });
    const kana = /^[ぁ-んァ-ヶ一-龠々ー]+$/;
    /* 難易度は規則の唯一の例外。和語の語感が合わないので欧文のままにした。
       ただし添え書きの枚数は日本語 */
    ok(menu.every((m) => /^[a-z ]+$/.test(m.name)),
      `難易度は欧文で出る (${menu.map((m) => m.name).join(' / ')})`);
    ok(menu.every((m) => /^\d+枚$/.test(m.note)),
      `枚数は日本語の数え方 (${menu.map((m) => m.note).join(' / ')})`);

    // 窓の銘は「漢字の和名 + 小さな欧文」の二枚組
    await start(phone, 'normal');
    const plate = await phone.evaluate(() => {
      const el = document.getElementById('frame-name');
      const jp = el.querySelector('.jp'), en = el.querySelector('.en');
      const sJp = getComputedStyle(jp), sEn = getComputedStyle(en);
      return { jp: jp.textContent.trim(), en: en.textContent.trim(),
               jpSize: parseFloat(sJp.fontSize), enSize: parseFloat(sEn.fontSize),
               shown: el.classList.contains('show') };
    });
    ok(plate.shown && kana.test(plate.jp.replace(/[─\s]/g, '')),
      `窓の銘が和名で出る (${plate.jp})`);
    ok(/^[A-Z ]+$/.test(plate.en) && plate.enSize < plate.jpSize,
      `欧文は添え名として小さく出る (${plate.en} / ${plate.enSize}px < ${plate.jpSize}px)`);

    // 二段にしたぶん、銘が窓にかぶっていないか
    const clear = await phone.evaluate(() => {
      const r = document.getElementById('frame-name').getBoundingClientRect();
      const p = window.__app.state().panel;
      return { bottom: Math.round(r.bottom), top: Math.round(p.y) };
    });
    ok(clear.bottom <= clear.top,
      `銘が窓にかぶらない (銘の下端 ${clear.bottom}px / 窓の上端 ${clear.top}px)`);

    // のこり枚数も日本語
    await phone.evaluate(() => {
      const c = window.__app.cellCenter(0); window.__app.tapCell(c.x, c.y);
    });
    await phone.waitForTimeout(80);
    const remainText = (await phone.textContent('#remain')).trim();
    ok(/^のこり \d+ 枚$/.test(remainText), `のこり枚数も日本語 (${remainText})`);

    // 画面に出ている言葉に、英語の取り残しが無いか
    const strays = await phone.evaluate(() => {
      /* 欧文が出てよいのは2か所だけ。ここに挙がっていない英語が画面に
         出ていたら、規則から漏れている */
      const allowed = ['#frame-name .en',            /* 窓の銘の添え名 */
                       '.start-btn[data-diff] .name']; /* 難易度(唯一の例外) */
      const out = [];
      const walk = (n) => {
        if (n.nodeType === 3) {
          const t = n.textContent.trim();
          if (t && /[A-Za-z]/.test(t) &&
              !allowed.some((sel) => n.parentElement.closest(sel))) out.push(t);
          return;
        }
        if (n.nodeType !== 1 || n.hidden) return;
        const st = getComputedStyle(n);
        if (st.display === 'none' || st.opacity === '0') return;   /* 消えかけも数えない */
        for (const c of n.childNodes) walk(c);
      };
      walk(document.body);
      return out;
    });
    ok(strays.length === 0,
      `決めた2か所のほかに英語が出ていない${strays.length ? ' — ' + strays.join(' / ') : ''}`);

    // ------------------------------------------------ 色を選ぶ帯
    section('色を選ぶ帯');
    const barMetrics = await phone.evaluate(() => {
      const sw = [...document.querySelectorAll('.swatch')];
      const box = sw.map((e) => e.getBoundingClientRect());
      const disc = sw.map((e) => e.querySelector('i').getBoundingClientRect());
      const row = document.getElementById('swatches');
      return {
        n: sw.length,
        tapMin: Math.round(Math.min(...box.map((r) => Math.min(r.width, r.height)))),
        discMin: Math.round(Math.min(...disc.map((r) => r.width))),
        bottomGap: Math.round(window.innerHeight - Math.max(...box.map((r) => r.bottom))),
        scrollable: row.scrollWidth > row.clientWidth + 1,
      };
    });
    /* Apple の目安は 44pt。前は 26px しかなく、押しにくかった */
    ok(barMetrics.tapMin >= 44, `色の丸は指で押せる大きさ (押せる所 ${barMetrics.tapMin}px)`);
    ok(barMetrics.discMin >= 32, `丸そのものも小さすぎない (${barMetrics.discMin}px)`);
    /* 画面のいちばん下は、ホームバーを上げる指の通り道 */
    ok(barMetrics.bottomGap >= 16,
      `色の帯が画面のいちばん下から離れている (${barMetrics.bottomGap}px)`);

    // 押した色が、実際にその色味で嵌まるか
    const pick = await phone.evaluate(async () => {
      const sw = [...document.querySelectorAll('.swatch')];
      const el = sw[sw.length - 1];
      el.scrollIntoView({ inline: 'center' });
      await new Promise((r) => setTimeout(r, 60));
      el.click();
      const idx = Number(el.dataset.family);
      window.__app.newWindow('veasy');
      const c = window.__app.cellCenter(0);
      window.__app.tapCell(c.x, c.y);
      const got = window.__app.state().fills.find((f) => f !== null);
      return { name: window.Core.COLOR_FAMILIES[idx].name,
               ok: window.Core.COLOR_FAMILIES[idx].shades.includes(got), got };
    });
    ok(pick.ok, `選んだ色「${pick.name}」の硝子が嵌まる (${pick.got})`);

    // 色は二段に並び、全部が見えている(なぞらずに押せる)
    const rows = await phone.evaluate(() => {
      const sw = [...document.querySelectorAll('.swatch')];
      const tops = [...new Set(sw.map((e) => Math.round(e.getBoundingClientRect().top)))];
      const row = document.getElementById('swatches');
      const r = row.getBoundingClientRect();
      const outside = sw.filter((e) => {
        const b = e.getBoundingClientRect();
        return b.left < r.left - 1 || b.right > r.right + 1 ||
               b.top < r.top - 1 || b.bottom > r.bottom + 1;
      }).length;
      return { n: sw.length, lines: tops.length, outside,
               scrollable: row.scrollWidth > row.clientWidth + 1 };
    });
    ok(rows.lines === 2, `色は二段に並ぶ (${rows.n} 色 / ${rows.lines} 段)`);
    ok(rows.outside === 0 && !rows.scrollable,
      `どの色も帯の中に見えている (はみ出し ${rows.outside} 個)`);

    // 20色そろっても、全部が見えていて、押せる大きさを割らないか
    await phone.evaluate(() => {
      localStorage.setItem('stained-glass:progress',
        JSON.stringify({ cleared: 40, frame: 'kokutan' }));
    });
    await phone.reload();
    await phone.waitForFunction(() => window.__app);
    await start(phone, 'normal');
    const full = await phone.evaluate(() => {
      const sw = [...document.querySelectorAll('.swatch')];
      const tops = [...new Set(sw.map((e) => Math.round(e.getBoundingClientRect().top)))];
      const row = document.getElementById('swatches').getBoundingClientRect();
      const outside = sw.filter((e) => {
        const b = e.getBoundingClientRect();
        return b.left < row.left - 1 || b.right > row.right + 1;
      }).length;
      return { n: sw.length, lines: tops.length, outside,
               tap: Math.round(sw[0].getBoundingClientRect().width) };
    });
    ok(full.n === 20 && full.outside === 0,
      `色が 20 になっても全部見えている (${full.lines} 段 / はみ出し ${full.outside} 個)`);
    /* 詰まってきたら丸は小さくなるが、32px は割らない (割るなら段を増やす) */
    ok(full.tap >= 32, `詰まっても押せる大きさを割らない (${full.tap}px)`);
    ok(full.lines <= 3, `段が増えても三段まで (${full.lines} 段)`);
    await phone.evaluate(() => localStorage.removeItem('stained-glass:progress'));
    await phone.reload();
    await phone.waitForFunction(() => window.__app);
    await start(phone, 'normal');

    // ------------------------------------------------ 硝子棚
    section('硝子棚');
    await phone.locator('#to-title').tap();
    await phone.waitForTimeout(120);
    await phone.evaluate(() => localStorage.removeItem('stained-glass:progress'));
    await phone.reload();
    await phone.waitForFunction(() => window.__app);

    const shelfStart = await phone.evaluate(() => ({
      swatches: document.querySelectorAll('.swatch').length,
      all: window.Core.COLOR_FAMILIES.length,
      cleared: window.__app.cleared(),
    }));
    ok(shelfStart.cleared === 0 && shelfStart.swatches === 10 && shelfStart.all === 20,
      `はじめは ${shelfStart.swatches} 色 (棚には全部で ${shelfStart.all} 色)`);

    await phone.locator('#shelf-open').tap();
    await phone.waitForTimeout(200);
    const shelf = await phone.evaluate(() => ({
      shown: !document.getElementById('shelf').hidden,
      colors: document.querySelectorAll('#shelf-colors .shelf-item').length,
      locked: document.querySelectorAll('#shelf-colors .shelf-item.locked').length,
      frames: document.querySelectorAll('#shelf-frames .shelf-item').length,
      framesLocked: document.querySelectorAll('#shelf-frames .shelf-item.locked').length,
      tally: document.getElementById('shelf-tally').textContent,
    }));
    ok(shelf.shown && shelf.colors === 20 && shelf.locked === 10,
      `棚には 20 色ぜんぶ並び、まだの ${shelf.locked} 色は灰色`);
    ok(shelf.frames === 5 && shelf.framesLocked === 4,
      `木枠は ${shelf.frames} 種、まだの ${shelf.framesLocked} 種は灰色`);
    ok(/つぎは/.test(shelf.tally) && /あと/.test(shelf.tally),
      `つぎに増える物が出ている (${shelf.tally.replace(/\s+/g, ' ').trim()})`);
    await phone.locator('#shelf-close').tap();
    await phone.waitForTimeout(120);
    ok(await phone.evaluate(() => document.getElementById('shelf').hidden),
      '棚はとじられる');

    // 窓を1つ仕上げると、数が増えて色も増える
    await start(phone, 'veasy');
    const grew = await phone.evaluate(async () => {
      const before = { cleared: window.__app.cleared(),
                       swatches: document.querySelectorAll('.swatch').length };
      const s = window.__app.state();
      for (let i = 0; i < s.cells.length; i++) {
        if (s.hosts[i] !== i) continue;
        const c = window.__app.cellCenter(i);
        window.__app.tapCell(c.x, c.y);
      }
      await new Promise((r) => setTimeout(r, 1200));   /* お知らせは鐘のあと */
      return { before,
               cleared: window.__app.cleared(),
               swatches: document.querySelectorAll('.swatch').length,
               note: document.getElementById('unlock').classList.contains('show'),
               noteText: document.getElementById('unlock').textContent,
               completed: window.__app.state().completed };
    });
    ok(grew.completed && grew.cleared === grew.before.cleared + 1,
      `窓を1つ仕上げると、仕上げた窓が ${grew.before.cleared} → ${grew.cleared} になる`);
    ok(grew.swatches === grew.before.swatches + 1,
      `色がその場で ${grew.before.swatches} → ${grew.swatches} に増える`);
    ok(grew.note && /臙脂/.test(grew.noteText),
      `増えたことを知らせる (${grew.noteText})`);

    // 仕上げた窓は、開き直しても二重に数えない
    await phone.reload();
    await phone.waitForFunction(() => window.__app);
    ok(await phone.evaluate(() => window.__app.cleared()) === grew.cleared,
      '開き直しても、同じ窓を二重に数えない');

    // 木枠は、手に入れた物だけ選べる
    await phone.evaluate(() => {
      localStorage.setItem('stained-glass:progress',
        JSON.stringify({ cleared: 10, frame: 'shunuri' }));
    });
    await phone.reload();
    await phone.waitForFunction(() => window.__app);
    await phone.locator('#shelf-open').tap();
    await phone.waitForTimeout(200);
    ok(await phone.evaluate(() =>
      document.querySelectorAll('#shelf-frames .shelf-item.picked').length === 1),
      '選んでいる木枠に印が付く');
    // まだ手に入れていない木枠がしまってあったら、最初の物に戻す
    await phone.evaluate(() => {
      localStorage.setItem('stained-glass:progress',
        JSON.stringify({ cleared: 0, frame: 'seidou' }));
    });
    await phone.reload();
    await phone.waitForFunction(() => window.__app);
    ok(await phone.evaluate(() => window.__app.frame() === window.Core.FRAMES[0].key),
      'まだ手に入れていない木枠がしまってあっても、最初の木枠で開く');
    // 壊れたものが入っていても落ちない
    await phone.evaluate(() => localStorage.setItem('stained-glass:progress', '{こわれている'));
    await phone.reload();
    await phone.waitForFunction(() => window.__app);
    ok(await phone.evaluate(() => window.__app.cleared()) === 0 &&
       await phone.evaluate(() => window.__app.screen()) === 'title',
      '棚の記録が壊れていても、普通に開ける');
    await phone.evaluate(() => localStorage.removeItem('stained-glass:progress'));
    await phone.reload();
    await phone.waitForFunction(() => window.__app);
    /* このあとの節は「塗りかけの窓」を前提にしているので、何枚か嵌めておく */
    await start(phone, 'normal');
    await phone.evaluate(() => {
      const s = window.__app.state();
      for (let i = 0, n = 0; i < s.cells.length && n < 5; i++) {
        if (s.hosts[i] !== i) continue;
        const c = window.__app.cellCenter(i);
        window.__app.tapCell(c.x, c.y);
        n++;
      }
    });
    await phone.waitForTimeout(150);

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
    /* タイトルでは操作帯が隠れている。そこで窓を組み直すと大きさが変わり、
       かけらの預け先が変わって枚数が1枚ずれる。どちらの画面でも同じ大きさか */
    const panelTitle = (await state(phone)).panel;
    await phone.locator('#go-resume').tap();
    await phone.waitForTimeout(250);
    const panelPlay = (await state(phone)).panel;
    ok(Math.abs(panelTitle.w - panelPlay.w) < 0.5 && Math.abs(panelTitle.h - panelPlay.h) < 0.5,
      `タイトルでも遊ぶ画面でも窓の大きさが同じ ` +
      `(${Math.round(panelTitle.w)}x${Math.round(panelTitle.h)} / ` +
      `${Math.round(panelPlay.w)}x${Math.round(panelPlay.h)})`);
    ok((await state(phone)).remain === kept.remain,
      `のこり枚数も画面をまたいで変わらない (${kept.remain})`);
    await phone.locator('#to-title').tap();
    await phone.waitForTimeout(150);

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
    const DIFFS = await phone.evaluate(() => window.Core.DIFF_ORDER);
    ok(DIFFS.length === 5, `段は ${DIFFS.length} 段 (${DIFFS.join(' / ')})`);
    for (const key of DIFFS) {
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
    ok(DIFFS.every((k, i) => i === 0 || counts[DIFFS[i - 1]] < counts[k]),
      `難易度が上がるほど枚数が増える (${JSON.stringify(counts)})`);

    // 同じ難易度を引き直しても、手応えが別物にならないか。
    // 以前は normal で 12枚と48枚、easy で 8枚と18枚の窓が出ていた。
    // いまは出来上がりの押す枚数を見て、帯から外れたら引き直している
    for (const key of DIFFS) {
      const draws = [];
      for (let i = 0; i < 14; i++) {
        await draw(phone, key);
        const s = await state(phone);
        draws.push(s.remain);
      }
      const { target, slack } = await phone.evaluate((k) => ({
        target: window.Core.DIFF_TARGET[k], slack: window.Core.fitSlack(window.Core.DIFF_TARGET[k]),
      }), key);
      const out = draws.filter((n) => !(Math.abs(n - target) <= slack));
      const lo = Math.min(...draws), hi = Math.max(...draws);
      ok(out.length === 0,
        `${key}: 14回引いても ${lo}〜${hi} 枚 (目標 ${target} ± ${slack.toFixed(1)})`);
      ok(hi / lo <= 2,
        `${key}: いちばん多い窓と少ない窓の差が 2 倍以内 (${(hi / lo).toFixed(1)} 倍)`);
    }

    // 段の間隔がそろっているか(easy→normal だけが4倍の崖だった)
    const ladder = await phone.evaluate(() => {
      const t = window.Core.DIFF_ORDER.map((k) => window.Core.DIFF_TARGET[k]);
      return t.slice(1).map((n, i) => n / t[i]);
    });
    ok(Math.max(...ladder) / Math.min(...ladder) <= 1.5,
      `段の間隔がそろっている (${ladder.map((r) => r.toFixed(2) + '倍').join(' / ')})`);

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
