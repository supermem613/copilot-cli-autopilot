// Sidecar: per-session HTTP+WS server that drives a chromeless browser window
// for mission. Lifecycle bound to status: visible iff status !== "idle".
//
// Design: simpler than backlog's multi-session owner-election model. Each
// Copilot session spawns its own extension process, so each gets its own
// sidecar on its own ephemeral 127.0.0.1 port. No coordination across sessions.
//
// Security: token-gated on 127.0.0.1 only. The token is per-session, minted
// at startup, and required on every WS handshake and HTTP /api request.
//
// Wire protocol:
//   Server → client: { type: "state", state: <full state snapshot> }
//                    { type: "close" }  (asks the page to close itself)
//   Client → server: POST /api/action { action: "pause"|"resume"|"clear"|"off"|"on" }

import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWER_HTML = readFileSync(join(__dirname, "viewer.html"), "utf8");
const FAVICON_SVG = readFileSync(join(__dirname, "favicon.svg"));

// Match session.workspacePath profile dir, separate from backlog's so
// browser cookies/history don't collide.
const VIEWER_PROFILE_DIR = join(homedir(), ".copilot", "mission-viewer-profile");

export function createSidecar({ controller, sessionId, log, noLaunch = false }) {
    const token = randomBytes(16).toString("hex");
    let server = null;
    let port = null;
    let viewerSpawnedAt = null;
    const wsClients = new Set();
    let programmaticClose = false;
    // Serialize lifecycle transitions so two near-simultaneous syncVisibility
    // calls cannot both enter ensureRunning() / stop() and orphan a server
    // or app window. Shadow review #1.
    let lifecycleQueue = Promise.resolve();
    function withLifecycleLock(fn) {
        const next = lifecycleQueue.then(fn, fn);
        lifecycleQueue = next.catch(() => {});
        return next;
    }

    function broadcast(state) {
        const msg = JSON.stringify({ type: "state", state });
        for (const sock of wsClients) {
            try { wsSendText(sock, msg); } catch { /* socket dead, will GC on close */ }
        }
    }

    // Lifecycle: visible iff status is not "idle". When status returns to
    // "idle" (cleared) AND mission is enabled, hide. When disabled, hide.
    // Serialized so concurrent state notifications can't race ensureRunning/stop.
    function syncVisibility(state) {
        return withLifecycleLock(async () => {
            const shouldShow = state.enabled && state.status !== "idle";
            if (shouldShow) {
                if (!server) {
                    await startServer();
                    launchViewerIfMissing();
                } else {
                    launchViewerIfMissing();
                }
                broadcast(state);
            } else if (server) {
                await stopInternal();
            }
        });
    }

    function launchViewerIfMissing() {
        if (noLaunch || wsClients.size > 0) return;
        if (viewerSpawnedAt && Date.now() - viewerSpawnedAt < 5000) return;
        if (spawnViewerWindow()) viewerSpawnedAt = Date.now();
    }

    async function stopInternal() {
        if (!server) return;
        // Ask the page to close itself before tearing down WS. The viewer
        // honors {type:"close"} by setting closing=true (suppresses reconnect)
        // and calling window.close().
        programmaticClose = true;
        for (const ws of wsClients) {
            try { wsSendText(ws, JSON.stringify({ type: "close" })); } catch {}
        }
        await sleep(150);
        for (const ws of wsClients) { try { wsSendClose(ws); } catch {} }
        wsClients.clear();
        await new Promise((r) => server.close(r));
        server = null;
        port = null;
        programmaticClose = false;
    }

    function startServer() {
        return new Promise((resolve, reject) => {
            const s = createHttpServer();
            s.on("request", (req, res) => {
                handleHttp(req, res).catch((e) => {
                    try { res.writeHead(500); res.end("server error: " + e.message); } catch {}
                });
            });
            s.on("upgrade", (req, sock) => {
                const url = new URL(req.url, "http://x");
                if (url.pathname !== "/ws") {
                    sock.write("HTTP/1.1 404 Not Found\r\n\r\n");
                    sock.destroy();
                    return;
                }
                if (url.searchParams.get("token") !== token) {
                    sock.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                    sock.destroy();
                    return;
                }
                acceptWs(req, sock);
            });
            s.on("error", reject);
            // 127.0.0.1 only; OS-assigned port (0).
            s.listen(0, "127.0.0.1", () => {
                port = s.address().port;
                server = s;
                resolve();
            });
        });
    }

    async function handleHttp(req, res) {
        const url = new URL(req.url, "http://x");
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
            // The token is already in the URL the browser was launched with;
            // we just serve the HTML (which reads its own token from location.search).
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(VIEWER_HTML);
            return;
        }
        if (req.method === "GET" && url.pathname === "/favicon.svg") {
            res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
            res.end(FAVICON_SVG);
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/action") {
            if (req.headers["x-token"] !== token) {
                res.writeHead(401); res.end("unauthorized"); return;
            }
            const body = await readBody(req);
            let action;
            try { action = JSON.parse(body).action; } catch { res.writeHead(400); res.end("bad json"); return; }
            await dispatchAction(action);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.writeHead(404); res.end("not found");
    }

    async function dispatchAction(action) {
        try {
            switch (action) {
                case "pause":  await controller.pause(); break;
                case "resume": await controller.resume(); break;
                case "clear":  await controller.clearObjective(); break;
                case "off":    await controller.turnOff(); break;
                case "on":     await controller.turnOn(); break;
                default:
                    await log(`mission sidecar: unknown action "${action}"`, { level: "warning" });
            }
        } catch (err) {
            await log(`mission sidecar: action "${action}" failed: ${err?.message ?? err}`,
                { level: "error" });
        }
    }

    function acceptWs(req, sock) {
        const key = req.headers["sec-websocket-key"];
        if (!key) { sock.destroy(); return; }
        const accept = wsAcceptKey(key);
        sock.write([
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            "", "",
        ].join("\r\n"));
        wsClients.add(sock);
        sock.on("close", () => { wsClients.delete(sock); });
        sock.on("error", () => { wsClients.delete(sock); try { sock.destroy(); } catch {} });
        // Push current state immediately so the page renders without waiting
        // for the next mutation.
        try { wsSendText(sock, JSON.stringify({ type: "state", state: controller.snapshot })); } catch {}
    }

    function spawnViewerWindow() {
        const url = `http://127.0.0.1:${port}/?token=${token}&sid=${encodeURIComponent(sessionId)}`;
        const browser = findAppBrowser();
        if (browser) {
            if (!existsSync(VIEWER_PROFILE_DIR)) mkdirSync(VIEWER_PROFILE_DIR, { recursive: true });
            const args = [
                `--app=${url}`,
                `--user-data-dir=${VIEWER_PROFILE_DIR}`,
                "--window-size=440,390",
                "--window-position=1380,80",
                "--no-first-run",
                "--no-default-browser-check",
            ];
            // Detached + unref: launcher proc exits within ~1s; the actual
            // window is owned by the long-lived browser process.
            spawn(browser, args, { detached: true, stdio: "ignore" }).unref();
            return true;
        }
        if (platform() === "win32") {
            spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
            return true;
        }
        // Last resort: log the URL so the user can open it manually.
        log(`mission sidecar: open this URL manually: ${url}`, { level: "warning" }).catch(() => {});
        return false;
    }

    return {
        syncVisibility,
        async shutdown() { await withLifecycleLock(stopInternal); },
        get isRunning() { return server !== null; },
        get port() { return port; },
        get token() { return token; },
    };
}

// ---- helpers ----

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function wsAcceptKey(clientKey) {
    return createHash("sha1")
        .update(clientKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
}

// Server→client text frame. Single-fragment, no mask (server frames must NOT be masked).
function wsSendText(sock, str) {
    const payload = Buffer.from(str, "utf8");
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    sock.write(Buffer.concat([header, payload]));
}

function wsSendClose(sock) {
    try { sock.write(Buffer.from([0x88, 0x00])); } catch {}
    try { sock.end(); } catch {}
}

function findAppBrowser() {
    if (platform() !== "win32") return null;
    const local = join(homedir(), "AppData", "Local");
    const candidates = [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        join(local, "Microsoft\\Edge\\Application\\msedge.exe"),
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        join(local, "Google\\Chrome\\Application\\chrome.exe"),
    ];
    for (const p of candidates) { if (existsSync(p)) return p; }
    return null;
}
