// ui-small/app-server.mjs — creates the HTTP server but does not listen.
// Loopback-only by construction: listening (and port choice) lives in server.mjs.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const here = path.dirname(fileURLToPath(import.meta.url));

async function pageIndex() {
    return readFile(path.join(here, "index.html"), "utf8");
}

export const server = createServer(async (req, res) => {
    if (req.method !== "GET" || new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/") {
        res.statusCode = 404;
        res.end("not found");
        return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(await pageIndex());
});
