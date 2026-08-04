/* 縦view Service Worker — network-first shell cache (no version UI)
 *
 * オンライン: 常にネットの HTML を優先し、成功時にキャッシュ更新
 * オフライン: 前回成功分のキャッシュがあればそれを返す
 * 対象は同一ディレクトリのシェルだけ（TateView.html / manifest / icons / この sw.js）
 * file:// では登録されない（ページ側）
 */
/* キャッシュ名を変えると activate で旧キャッシュを捨てる（SW ファイル更新時に上げる） */
var CACHE = "tateview-shell-v2";

var SHELL = [
  "./TateView.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./sw.js"
];

function toAbs(path) {
  return new URL(path, self.registration.scope).href;
}

function isShellUrl(url) {
  try {
    var u = typeof url === "string" ? new URL(url) : url;
    if (u.origin !== self.location.origin) return false;
    var shell = SHELL.map(toAbs);
    if (shell.indexOf(u.href) >= 0) return true;
    var html = toAbs("./TateView.html");
    if (u.pathname === new URL(html).pathname) return true;
    return false;
  } catch (e) {
    return false;
  }
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(
        SHELL.map(function (p) {
          var req = new Request(toAbs(p), { cache: "reload" });
          return fetch(req)
            .then(function (res) {
              if (res && res.ok) return cache.put(req, res.clone());
            })
            .catch(function () { /* 初回オフライン等は無視 */ });
        })
      );
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (k) {
          if (k !== CACHE && k.indexOf("tateview-shell-") === 0) {
            return caches.delete(k);
          }
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // ナビゲーション（ホーム画面起動・アドレス入力）も network-first
  var nav = req.mode === "navigate";
  if (!nav && !isShellUrl(url)) return;

  event.respondWith(networkFirst(req, nav));
});

function networkFirst(req, isNavigate) {
  return fetch(req)
    .then(function (res) {
      if (res && res.ok && (isNavigate || isShellUrl(req.url))) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) {
          // navigate は TateView.html としても保存（オフライン起動用）
          if (isNavigate) {
            cache.put(toAbs("./TateView.html"), copy.clone()).catch(function () {});
          }
          cache.put(req, copy).catch(function () {});
        });
      }
      return res;
    })
    .catch(function () {
      return caches.open(CACHE).then(function (cache) {
        return cache.match(req).then(function (hit) {
          if (hit) return hit;
          if (isNavigate) return cache.match(toAbs("./TateView.html"));
          return cache.match(toAbs("./TateView.html"));
        }).then(function (hit2) {
          if (hit2) return hit2;
          return new Response("tateview: offline and no cache", {
            status: 503,
            statusText: "Service Unavailable",
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        });
      });
    });
}
