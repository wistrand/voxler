// Serves the GitHub Pages site: docs/ as the site root, the built demo under play/, and
// **no COOP/COEP**, because Pages cannot set response headers. `serve.ts` always sends
// them, so it is the wrong thing to preview the site with: it would hide anything that
// depends on cross-origin isolation.
//
// The engine has a path for that (the payload arena falls back to a plain ArrayBuffer and
// mesh jobs copy instead of sharing), and this is how to check it still does.
//
// docs/ and dist/ are routed off disk rather than copied the way the workflow copies them,
// so an edit to docs/index.html shows on reload.
//
// It serves at / by default. A project site actually lives at
// https://<user>.github.io/<repo>/, and serving under that subpath would catch a path
// that is absolute when it should be relative, which is silent locally and broken once
// deployed. Nothing in the site is absolute today, so that is a guard against a mistake
// nobody has made yet, and it is not worth an odd URL every day: `BASE=voxler` turns it on
// when you want to check, and a custom domain would put the real site at / anyway.
//
// Env: HOST (default 127.0.0.1), PORT (default 8001, then the next free one), BASE (serve
// under a subpath instead of /).

const DOCS = new URL("./docs/", import.meta.url);
const DIST = new URL("./dist/", import.meta.url);
const HOSTNAME = Deno.env.get("HOST") ?? "127.0.0.1";
const PORT_ENV = Deno.env.get("PORT");
const DEFAULT_PORT = 8001; // not serve.ts's 8000, so both can run at once
const PORT_ATTEMPTS = 20;
// `BASE=voxler` serves the site at /voxler/ instead of /, to mirror a project site on
// github.io. Empty or unset is /.
const BASE_ENV = (Deno.env.get("BASE") ?? "").replace(/^\/|\/$/g, "");
const BASE = BASE_ENV === "" ? "/" : `/${BASE_ENV}/`;
const PLAY = `${BASE}play/`;

// No Cross-Origin-* here, on purpose: see the note at the top.
const BASE_HEADERS: Record<string, string> = { "Cache-Control": "no-store" };

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
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

// Which directory a request lands in, and where inside it. Null only when BASE is set and
// the request is outside it, which on github.io would be another repo's site.
function route(path: string): { root: URL; rest: string } | null {
  if (path.startsWith(PLAY)) return { root: DIST, rest: path.slice(PLAY.length) };
  if (path.startsWith(BASE)) return { root: DOCS, rest: path.slice(BASE.length) };
  return null;
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return plain(405, "method not allowed");

  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url).pathname);
  } catch {
    return plain(400, "bad path");
  }
  if (/[\0?#\\]/.test(path)) return plain(400, "bad path");
  // The one redirect Pages itself does: a directory without its trailing slash.
  if (path !== "" && (path + "/" === BASE || path + "/" === PLAY)) {
    return new Response(null, { status: 301, headers: { Location: path + "/" } });
  }

  const found = route(path);
  if (found === null) return plain(404, `not found (the site is served under ${BASE})`);

  const rest = found.rest === "" || found.rest.endsWith("/") ? found.rest + "index.html" : found.rest;

  const file = new URL(rest, found.root);
  if (!file.href.startsWith(found.root.href)) return plain(403, "forbidden");

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
    "Content-Type": contentType(rest),
    "Content-Length": String(info.size),
  };
  if (req.method === "HEAD") {
    fsFile.close();
    return new Response(null, { headers });
  }
  return new Response(fsFile.readable, { headers });
}

try {
  await Deno.stat(new URL("index.html", DIST));
} catch {
  console.warn("dist/index.html not found; the demo under play/ will 404. Run `deno task build`");
}

function listen(): void {
  const started = (port: number) => {
    console.log(`site   http://${HOSTNAME}:${port}${BASE}`);
    console.log(`demo   http://${HOSTNAME}:${port}${PLAY}?world=forest`);
    console.log("no COOP/COEP, as on GitHub Pages: SharedArrayBuffer is unavailable here");
  };
  if (PORT_ENV !== undefined) {
    const port = Number(PORT_ENV);
    try {
      Deno.serve({ hostname: HOSTNAME, port }, handle);
    } catch (err) {
      if (!(err instanceof Deno.errors.AddrInUse)) throw err;
      console.error(`port ${port} is in use; pick another with PORT=<n>`);
      Deno.exit(1);
    }
    started(port);
    return;
  }
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_ATTEMPTS; port++) {
    try {
      Deno.serve({ hostname: HOSTNAME, port }, handle);
      started(port);
      return;
    } catch (err) {
      if (!(err instanceof Deno.errors.AddrInUse)) throw err;
    }
  }
  console.error(`ports ${DEFAULT_PORT}-${DEFAULT_PORT + PORT_ATTEMPTS - 1} are all in use; set PORT=<n>`);
  Deno.exit(1);
}

listen();
