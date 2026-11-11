// ui-small/server.mjs — starts the server from app-server.mjs.
// Loopback-only, ephemeral port. Publishes the chosen port on stdout so the
// pilot can capture it; use that port with checks/http-check.mjs.
import { server } from "./app-server.mjs";

server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    console.log(`UI-SMALL_PORT=${port}`);
});
