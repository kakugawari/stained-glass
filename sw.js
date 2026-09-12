/* ============================================================
   ステンドグラス Service Worker
   - 画面とコードは「つながっていれば最新を取りにいく」(network-first)。
     キャッシュ優先にすると、直したのに古い画面が出る。実際に踏んだ。
   - 絵(アイコン)は中身が変わらないのでキャッシュ優先のまま。速い。
   - オフラインでは、最後に取れたものを返す。
   ============================================================ */
const CACHE_NAME = "stained-glass-v8";

const ASSETS = [
  "./",
  "./index.html",
  "./core.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png",
];

/* 中身が変わりうるもの(画面・コード・設定)。ここだけ最新を取りにいく */
const isFresh = (url) =>
  /\.(?:html|js|json|webmanifest)$/.test(url.pathname) || url.pathname.endsWith("/");

/* インストール:必要なファイルを先読みキャッシュ */
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

/* 有効化:旧バージョンのキャッシュを削除 */
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* 取れた物をキャッシュへ写す(正常な応答だけ) */
async function keep(request, response) {
  if (response && response.ok && response.type === "basic") {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

/* 最新優先:ネットへ。だめならキャッシュ。画面ならindex.htmlで受け止める */
async function freshFirst(request) {
  try {
    return await keep(request, await fetch(request));
  } catch (err) {
    const hit = await caches.match(request);
    if (hit) return hit;
    if (request.mode === "navigate") {
      const index = await caches.match("./index.html");
      if (index) return index;
    }
    throw err;
  }
}

/* キャッシュ優先:あればそれ。無ければネットへ取りにいって覚える */
async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  return keep(request, await fetch(request));
}

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   /* 外部は素通し */

  e.respondWith(
    request.mode === "navigate" || isFresh(url) ? freshFirst(request) : cacheFirst(request)
  );
});
