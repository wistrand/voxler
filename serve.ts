// Static server for dist/. Always sends COOP/COEP so the page is cross-origin
// isolated and SharedArrayBuffer is available. `--dev` also runs the esbuild
// watcher from build.ts.
//
// Env: HOST (bind address, default 127.0.0.1), PORT, and TLS_CERT + TLS_KEY (PEM
// paths) to serve HTTPS. Browsers expose WebGPU and SharedArrayBuffer only in a
// secure context, so any HOST other than loopback needs TLS to be useful.
//
// With --dev, POST /__bench/results saves a benchmark result (JSON from the page's
// `?bench=` runner) to bench/results/<scene>.<UTC timestamp>.<browser>.json.

const DEV = Deno.args.includes("--dev");
const DIST = new URL("./dist/", import.meta.url);
const BENCH_RESULTS = new URL("./bench/results/", import.meta.url);
const BENCH_ROUTE = "/__bench/results";
const MAX_BENCH_BYTES = 1 << 20;
const SCENE_NAME = /^[a-z0-9-]{1,40}$/;
const HOSTNAME = Deno.env.get("HOST") ?? "127.0.0.1";
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const TLS_CERT = Deno.env.get("TLS_CERT");
const TLS_KEY = Deno.env.get("TLS_KEY");
const PORT_ENV = Deno.env.get("PORT");
const DEFAULT_PORT = 8000;
const PORT_ATTEMPTS = 20; // without PORT set, try DEFAULT_PORT and the next ports

const BASE_HEADERS: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 && CONTENT_TYPES[path.slice(dot)]) || "application/octet-stream";
}

function plain(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

// Writes one benchmark result. The filename is built here from validated fields;
// nothing from the request is used as a path directly.
async function saveBenchResult(req: Request): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_BENCH_BYTES) return json(413, { error: "result too large" });
  let data: { scene?: unknown; browser?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    return json(400, { error: "not JSON" });
  }
  if (typeof data !== "object" || data === null) return json(400, { error: "not an object" });
  if (typeof data.scene !== "string" || !SCENE_NAME.test(data.scene)) {
    return json(400, { error: "bad scene name" });
  }
  const browser = String(data.browser ?? "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 40) || "unknown";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); // 20260911T101530Z
  const name = `${data.scene}.${stamp}.${browser}.json`;
  await Deno.writeTextFile(new URL(name, BENCH_RESULTS), JSON.stringify(data, null, 2) + "\n");
  console.log(`bench result saved: bench/results/${name}`);
  return json(200, { path: `bench/results/${name}` });
}

async function handle(req: Request): Promise<Response> {
  if (DEV && req.method === "POST" && new URL(req.url).pathname === BENCH_ROUTE) {
    return await saveBenchResult(req);
  }
  if (req.method !== "GET" && req.method !== "HEAD") return plain(405, "method not allowed");

  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url).pathname);
  } catch {
    return plain(400, "bad path");
  }
  if (/[\0?#\\]/.test(path)) return plain(400, "bad path");
  if (path.endsWith("/")) path += "index.html";

  const file = new URL("." + path, DIST);
  if (!file.href.startsWith(DIST.href)) return plain(403, "forbidden");

  let fsFile: Deno.FsFile;
  try {
    fsFile = await Deno.open(file);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return plain(404, "not found");
    throw err;
  }
  const info = await fsFile.stat();
  if (!info.isFile) {
    fsFile.close();
    return plain(404, "not found");
  }
  const headers = {
    ...BASE_HEADERS,
    "Content-Type": contentType(path),
    "Content-Length": String(info.size),
  };
  if (req.method === "HEAD") {
    fsFile.close();
    return new Response(null, { headers });
  }
  return new Response(fsFile.readable, { headers });
}

const tls = await loadTls();

if (DEV) {
  const { watch } = await import("./build.ts");
  await watch();
} else {
  try {
    await Deno.stat(new URL("index.html", DIST));
  } catch {
    console.warn("dist/index.html not found; run `deno task build` first");
  }
}

async function loadTls(): Promise<{ cert: string; key: string } | Record<never, never>> {
  if (TLS_CERT === undefined && TLS_KEY === undefined) {
    if (!LOOPBACK.has(HOSTNAME)) {
      console.warn(
        `serving plain HTTP on ${HOSTNAME}: browsers hide WebGPU and SharedArrayBuffer ` +
          "outside HTTPS or localhost; set TLS_CERT and TLS_KEY",
      );
    }
    return {};
  }
  if (TLS_CERT === undefined || TLS_KEY === undefined) {
    console.error("set both TLS_CERT and TLS_KEY, or neither");
    Deno.exit(1);
  }
  return { cert: await Deno.readTextFile(TLS_CERT), key: await Deno.readTextFile(TLS_KEY) };
}

function listen(): void {
  if (PORT_ENV !== undefined) {
    try {
      Deno.serve({ hostname: HOSTNAME, port: Number(PORT_ENV), ...tls }, handle);
    } catch (err) {
      if (!(err instanceof Deno.errors.AddrInUse)) throw err;
      console.error(`port ${PORT_ENV} is in use; pick another with PORT=<n>`);
      Deno.exit(1);
    }
    return;
  }
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_ATTEMPTS; port++) {
    try {
      Deno.serve({ hostname: HOSTNAME, port, ...tls }, handle);
      return;
    } catch (err) {
      if (!(err instanceof Deno.errors.AddrInUse)) throw err;
    }
  }
  console.error(`ports ${DEFAULT_PORT}-${DEFAULT_PORT + PORT_ATTEMPTS - 1} are all in use; set PORT=<n>`);
  Deno.exit(1);
}

listen();
