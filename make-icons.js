/*
 * アイコンを焼く。
 *
 *   node make-icons.js            # icon-512 / icon-192 / maskable / apple-touch
 *   node make-icons.js --sheet    # 見比べ用の一枚を scratch に出す
 *
 * アプリの中身と同じ手で作る —— 薄暗い洋館 (room.jpg) を地に、
 * その硝子窓を切り取って、こちらで描いた真鍮の木枠に嵌める。
 * 絵を切って貼るだけにしないのは、**木枠と光の付け方をアプリと
 * そろえたい**から。窓の形と枠の断面は index.html と同じ考え方
 * (外の溝 → 細く光る峰 → 内の溝) をなぞっている。
 *
 * 焼き直したら PNG を commit すること (走らせるのに playwright が要るので、
 * 配るのは出来上がった PNG のほう)。
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const ROOM = path.join(ROOT, "room.jpg");
const CHROMIUM = process.env.CHROMIUM_PATH;

/* room.jpg (1086x1448) の、硝子のいちばん美しい所。
   大きな蓮の文様がまんなかに来るように取る */
let CROP = { x: 770, y: 300, s: 250 };
/* 切り取りを試す時だけ:  CROP=760,220,270 node make-icons.js --sheet */
if (process.env.CROP) {
  const [x, y, s] = process.env.CROP.split(",").map(Number);
  CROP = { x, y, s };
}

/* 焼くもの。maskable は外側 20% が切り落とされうるので、窓を小さく置く。
   512 の2枚は JPEG にする —— 写真が地なので PNG だと 1枚 434KB になり、
   Service Worker の先読みだけで 1MB 近くなってしまう。
   透かす所は無いので JPEG で困らない。
   画面に出る 192 と apple-touch-icon は PNG のまま
   (iOS のホーム画面はここを見る。素性の知れた形にしておく) */
const JOBS = [
  { file: "icon-192.png",          size: 192, scale: 1.00, type: "image/png" },
  { file: "apple-touch-icon.png",  size: 180, scale: 1.00, type: "image/png" },
  { file: "icon-512.jpg",          size: 512, scale: 1.00, type: "image/jpeg" },
  { file: "icon-512-maskable.jpg", size: 512, scale: 0.78, type: "image/jpeg" },
];

/* ------------------------------------------------------------
   ブラウザの中で走る絵作り。canvas だけで描く
   ------------------------------------------------------------ */
function draw(img, S, scale, shape) {
  const cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const c = cv.getContext("2d");
  const U = S / 512;                     /* 512 を基準にした倍率 */
  const C = window.__crop;

  /* ---- 地。部屋の絵を大きくぼかして敷き、その上を暗幕で沈める ---- */
  c.fillStyle = "#14110e"; c.fillRect(0, 0, S, S);
  c.save();
  c.globalAlpha = 0.30;
  c.filter = "blur(" + (13 * U) + "px) saturate(0.8)";
  /* 窓まわりの壁 (絵の左寄り) を引き伸ばして、木目の気配だけ残す */
  c.drawImage(img, 330, 380, 420, 420, -S * 0.12, -S * 0.12, S * 1.24, S * 1.24);
  c.restore();
  c.fillStyle = "rgba(13,10,7,0.62)"; c.fillRect(0, 0, S, S);
  /* 窓の後ろから、壁へにじむ光 */
  const spill = c.createRadialGradient(S / 2, S * 0.46, 0, S / 2, S * 0.46, S * 0.56);
  spill.addColorStop(0, "rgba(255,226,166,0.16)");
  spill.addColorStop(1, "rgba(255,226,166,0)");
  c.fillStyle = spill; c.fillRect(0, 0, S, S);

  /* ---- 窓の外形 ----
     尖塔窓は切先が肩より上へ出るので、その**出るぶんも入れて**中に置く。
     入れずに置くと、切先と木枠がアイコンの上端で切られる */
  const w = S * 0.66 * scale, H = S * 0.82 * scale;
  const cx = S / 2, rad = w / 2;
  const over = shape === "gothic" ? rad * 0.30 : 0;
  const h = H - over;
  const topY = (S - H) / 2 + over, bot = topY + h;
  const L = cx - w / 2, R = cx + w / 2;
  const outline = (ctx) => {
    const t = topY, b = bot;
    ctx.beginPath();
    if (shape === "gothic") {
      const apex = t - over;
      ctx.moveTo(L, b); ctx.lineTo(L, t + rad * 0.55);
      ctx.quadraticCurveTo(L + rad * 0.12, apex + rad * 0.30, cx, apex);
      ctx.quadraticCurveTo(R - rad * 0.12, apex + rad * 0.30, R, t + rad * 0.55);
      ctx.lineTo(R, b);
    } else {
      ctx.moveTo(L, b); ctx.lineTo(L, t + rad);
      ctx.arc(cx, t + rad, rad, Math.PI, 0);
      ctx.lineTo(R, b);
    }
    ctx.closePath();
  };

  /* ---- 硝子。部屋の絵の硝子窓を切り取って、外形の中に嵌める ----
     高さで覆って左右は溢れさせる (蓮の文様がまんなかに来る)。
     小さく出す絵なので、色は少し強めに寄せる */
  c.save();
  outline(c); c.clip();
  const gTop = topY - over, gH = bot - gTop;
  const k = gH / C.s, dw = C.s * k;
  /* もとの JPEG の粒子は、PNG にすると重さになるだけ (512px で 434→? KB)。
     ごく弱くぼかしてから焼く。見た目は変わらない */
  c.filter = "saturate(1.45) contrast(1.16) brightness(0.93) blur(" + (0.7 * U) + "px)";
  c.drawImage(img, C.x, C.y, C.s, C.s, cx - dw / 2, gTop, dw, gH);
  c.filter = "none";
  /* 窓の奥から光。ふちへ向かって沈める */
  const glow = c.createRadialGradient(cx, gTop + gH * 0.42, 0, cx, gTop + gH * 0.44, gH * 0.66);
  glow.addColorStop(0, "rgba(255,246,220,0.12)");
  glow.addColorStop(0.58, "rgba(255,240,206,0.00)");
  glow.addColorStop(1, "rgba(16,10,5,0.46)");
  c.fillStyle = glow; c.fillRect(0, 0, S, S);
  c.restore();

  /* ---- 真鍮の木枠。外の溝 → 細く光る峰 → 内の溝 ---- */
  const b = S * 0.042 * (0.55 + 0.45 * scale);
  /* 線は外形の上に中心をそろえて引くので、t=0 が外と内の両ふち、
     t=1 が帯のまんなかになる。**profile は左右対称に出る** ——
     だからここは「ふちの溝 → 立ち上がり → 峰」の片側だけを書けばいい */
  const relief = (t) =>
      t < 0.18 ? -0.92                                   /* ふちの溝 */
    : t < 0.34 ? -0.92 + (t - 0.18) / 0.16 * 1.07        /* 立ち上がり */
    : 0.15 + 0.92 * Math.exp(-Math.pow((t - 0.60) / 0.19, 2));  /* 峰 */
  const BASE = [140, 103, 49];
  const mixed = (v) => {
    const k = v > 0 ? v * 0.52 : -v * 0.80;
    const to = v > 0 ? [255, 236, 190] : [0, 0, 0];
    return "rgb(" + BASE.map((n, i) => Math.round(n + (to[i] - n) * k)).join(",") + ")";
  };
  /* 壁に落ちる影 */
  c.save();
  c.shadowColor = "rgba(0,0,0,0.6)"; c.shadowBlur = b * 1.6; c.shadowOffsetY = b * 0.4;
  c.lineJoin = "round"; c.lineWidth = b * 2.1; c.strokeStyle = "rgba(0,0,0,0.9)";
  outline(c); c.stroke();
  c.restore();
  c.save();
  c.globalCompositeOperation = "destination-out";
  outline(c); c.fill();
  c.restore();

  c.lineJoin = "round";
  const FULL = b * 2.24, STEPS = 24;
  for (let i = 0; i < STEPS; i++) {
    const t = i / (STEPS - 1);
    c.lineWidth = FULL * (1 - t * 0.999);
    c.strokeStyle = mixed(relief(t));
    outline(c); c.stroke();
  }
  /* 金の象嵌を1本 */
  c.lineWidth = FULL * 0.78; c.strokeStyle = "rgba(214,178,104,0.55)";
  outline(c); c.stroke();
  c.lineWidth = FULL * 0.74; c.strokeStyle = mixed(relief(0.30));
  outline(c); c.stroke();

  /* 左上からの光を枠の上だけに */
  c.save();
  c.globalCompositeOperation = "source-atop";
  const lit = c.createLinearGradient(L, topY, R, bot);
  lit.addColorStop(0, "rgba(255,238,204,0.14)");
  lit.addColorStop(0.5, "rgba(255,240,208,0.02)");
  lit.addColorStop(1, "rgba(0,0,0,0.22)");
  c.fillStyle = lit; c.fillRect(0, 0, S, S);
  c.restore();

  /* ---- 四方に金の座金 (四つ星) ---- */
  const stud = (x, y, r, turn) => {
    c.save(); c.translate(x, y); c.rotate(turn);
    c.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      c.quadraticCurveTo(Math.cos(a + Math.PI / 4) * r * 0.26,
                         Math.sin(a + Math.PI / 4) * r * 0.26,
                         Math.cos(a + Math.PI / 2) * r, Math.sin(a + Math.PI / 2) * r);
    }
    c.closePath();
    c.fillStyle = "rgba(226,192,120,0.95)"; c.fill();
    c.lineWidth = r * 0.16; c.strokeStyle = "rgba(90,64,26,0.55)"; c.stroke();
    c.restore();
  };
  const sr = b * 0.70;
  stud(L, bot - b * 1.1, sr, 0);
  stud(R, bot - b * 1.1, sr, 0);
  stud(L, topY + h * 0.42, sr, 0);
  stud(R, topY + h * 0.42, sr, 0);

  /* ---- 全体をわずかに落として、角を沈める ---- */
  const vig = c.createRadialGradient(cx, S * 0.46, S * 0.34, cx, S * 0.5, S * 0.78);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(6,4,3,0.42)");
  c.fillStyle = vig; c.fillRect(0, 0, S, S);
  return cv;
}

async function run() {
  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch (e) { console.error("playwright が必要です:  npm i -D playwright"); process.exit(1); }
  const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const page = await browser.newPage();
  const src = "data:image/jpeg;base64," + fs.readFileSync(ROOM).toString("base64");
  await page.evaluate((c) => { window.__crop = c; }, CROP);
  await page.exposeFunction("noop", () => {});

  const sheet = process.argv.includes("--sheet");
  if (sheet) {
    const png = await page.evaluate(async ({ src, drawSrc, crop }) => {
      window.__crop = crop;
      const draw = eval("(" + drawSrc + ")");
      const img = new Image(); img.src = src; await img.decode();
      const S = 256, pad = 18;
      const kinds = ["round", "gothic"], sizes = [256, 96, 60];
      const cv = document.createElement("canvas");
      cv.width = pad + sizes.reduce((a, s) => a + s + pad, 0);
      cv.height = kinds.length * (S + pad) + pad;
      const c = cv.getContext("2d");
      c.fillStyle = "#1b1713"; c.fillRect(0, 0, cv.width, cv.height);
      kinds.forEach((k, r) => {
        let x = pad;
        sizes.forEach((s) => {
          const one = draw(img, 512, 1, k);
          c.drawImage(one, x, pad + r * (S + pad) + (S - s) / 2, s, s);
          x += s + pad;
        });
      });
      return cv.toDataURL("image/png");
    }, { src, drawSrc: draw.toString(), crop: CROP });
    const out = "/tmp/claude-0/-home-user/fb4317aa-491c-5744-a2b6-0cdd122907cb/scratchpad/shots/icons.png";
    fs.writeFileSync(out, Buffer.from(png.split(",")[1], "base64"));
    console.log("→ " + out);
  } else {
    for (const job of JOBS) {
      const png = await page.evaluate(async ({ src, drawSrc, crop, job }) => {
        window.__crop = crop;
        const draw = eval("(" + drawSrc + ")");
        const img = new Image(); img.src = src; await img.decode();
        return draw(img, job.size, job.scale, "gothic").toDataURL(job.type, 0.88);
      }, { src, drawSrc: draw.toString(), crop: CROP, job });
      const file = path.join(ROOT, job.file);
      fs.writeFileSync(file, Buffer.from(png.split(",")[1], "base64"));
      console.log(job.file.padEnd(24), job.size + "px",
                  (fs.statSync(file).size / 1024).toFixed(0) + "KB");
    }
  }
  await browser.close();
}
run();
