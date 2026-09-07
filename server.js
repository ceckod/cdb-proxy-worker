/* =========================================================
   shorts-relay-server — минимален CORS relay за GitHub Releases upload
   =========================================================

   ЗАЩО ТОЗИ СЪРВЪР СЪЩЕСТВУВА:
   GitHub-ският "upload_url" за Release assets сочи към uploads.github.com —
   различен домейн от api.github.com. api.github.com официално поддържа CORS
   за браузър заявки, uploads.github.com — НЕ (виж GitHub Docs "CORS and
   JSONP" — примерите там са само за api.github.com; общността е потвърждавала
   многократно, че GitHub нарочно не разширява CORS към "съседни" домейни по
   секюрити причини). Затова AI Shorts Studio (js/shorts-studio.js) не може
   директно от браузъра да качи голям аудио файл като Release asset —
   fetch()-ът умира с генеричен "Failed to fetch" (без ясна CORS грешка дори).

   Този малък сървър седи между браузъра и uploads.github.com: браузърът му
   праща файла (+ GitHub token + целевия upload URL в хедъри), той го
   препраща 1:1 (streaming, БЕЗ да буферира в паметта — req.pipe(upstreamReq),
   затова не е ограничен от типичните serverless/edge body лимити като
   Cloudflare Workers Free — 100MB) и връща отговора обратно С добавени CORS
   хедъри.

   АЛТЕРНАТИВА, КОЯТО ПРОВЕРИХМЕ И НЕ РАБОТИ: Cloudflare Workers (дори платени
   Business/Enterprise) имат мрежов таван на request body — 100MB на Free/Pro,
   200MB на Business, 500MB на Enterprise по подразбиране. Тоест Worker НЕ би
   дал истински 2GB. Затова тук е обикновен Node.js процес на "истински"
   free-tier хост (Render/Fly.io/Railway/собствен VPS) — без edge/serverless
   body лимит.

   СЕКЮРИТИ: този relay НЕ пази/генерира GitHub token — той е само тръба,
   token-ът идва от браузъра (Authorization хедъра) и се препраща directly.
   За да не стане отворен публичен прокси за произволен трафик (ако някой
   намери URL-а), изискваме:
     1) PROXY_SECRET (env var) да съвпада с X-Proxy-Secret хедъра
     2) целевият URL (X-Target-Url) да е задължително хост uploads.github.com
   ========================================================= */

const http = require("http");
const https = require("https");

const PROXY_SECRET = process.env.PROXY_SECRET || "";
const PORT = process.env.PORT || 3000;
// Единственият домейн, към който този relay има право да препраща —
// разширявай само ако наистина ти трябва (напр. ако по-късно решиш да
// пращаш и artifact downloads през него).
const ALLOWED_TARGET_HOSTS = new Set(["uploads.github.com"]);

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, X-Proxy-Secret, X-Target-Url");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const server = http.createServer((req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method !== "POST" || req.url !== "/upload") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found — POST /upload очакван");
    return;
  }

  if (!PROXY_SECRET) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Сървърът няма конфигуриран PROXY_SECRET (env var) — виж README.md" }));
    return;
  }

  if (req.headers["x-proxy-secret"] !== PROXY_SECRET) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Грешен или липсващ X-Proxy-Secret хедър" }));
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(req.headers["x-target-url"] || "");
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "X-Target-Url липсва или не е валиден URL" }));
    return;
  }

  if (!ALLOWED_TARGET_HOSTS.has(targetUrl.hostname)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Хост "${targetUrl.hostname}" не е разрешен (само: ${[...ALLOWED_TARGET_HOSTS].join(", ")})` }));
    return;
  }

  const upstreamHeaders = {
    Authorization: req.headers["authorization"] || "",
    Accept: "application/vnd.github+json",
    "Content-Type": req.headers["content-type"] || "application/octet-stream",
    "User-Agent": "cd-b-shorts-relay/1.0",
  };
  if (req.headers["content-length"]) upstreamHeaders["Content-Length"] = req.headers["content-length"];

  const upstreamReq = https.request(
    targetUrl,
    { method: "POST", headers: upstreamHeaders },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, {
        "Content-Type": upstreamRes.headers["content-type"] || "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on("error", (e) => {
    console.error("Upstream грешка:", e.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: "Upstream (GitHub) грешка: " + e.message }));
  });

  req.on("error", (e) => {
    console.error("Client request грешка:", e.message);
    upstreamReq.destroy();
  });

  // Истинско streaming pass-through — файлът НИКОГА не се буферира изцяло в
  // паметта на relay-я, затова спокойно минава и 500MB-2GB файл дори на
  // хост с 512MB RAM (Render free tier).
  req.pipe(upstreamReq);
});

// Голям timeout — 2GB файл на бавна мобилна връзка може да отнеме доста време.
server.timeout = 20 * 60 * 1000; // 20 минути
server.headersTimeout = 20 * 60 * 1000 + 5000;

server.listen(PORT, () => {
  console.log(`shorts-relay-server слуша на порт ${PORT} (PROXY_SECRET ${PROXY_SECRET ? "зададен" : "❌ ЛИПСВА"})`);
});
