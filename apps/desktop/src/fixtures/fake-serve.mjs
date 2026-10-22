// A stand-in for `passport serve` in the supervisor tests: a slow start, the owner lease and
// api-token files, /api/health, the bootstrap pipe and the parent pipe, and nothing else.
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const dir = process.env.PASSPORT_DATA_DIR;
const port = Number(process.env.PASSPORT_PORT);
const mode = process.env.FAKE_MODE ?? "real";
appendFileSync(join(dir, "spawned.log"), `${process.pid}\n`);
const report = {
  envKey: process.env.PASSPORT_MASTER_KEY ?? null,
  bootstrap: null,
  parent: process.env.PASSPORT_PARENT ?? null,
};
if (process.env.PASSPORT_BOOTSTRAP_FD) {
  report.bootstrap = JSON.parse(readFileSync(Number(process.env.PASSPORT_BOOTSTRAP_FD), "utf8"));
}
writeFileSync(join(dir, `report-${process.pid}.json`), JSON.stringify(report));
const tokenPath = join(dir, "api-token");
if (!existsSync(tokenPath)) {
  writeFileSync(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600 });
}
const lease = join(dir, "owner.lock");
const release = () => {
  try {
    if (JSON.parse(readFileSync(lease, "utf8")).pid === process.pid) {
      rmSync(lease, { force: true });
    }
  } catch {}
};
const stop = () => {
  release();
  process.exit(0);
};
process.on("SIGTERM", stop);
if (report.parent === "desktop") {
  process.stdin.once("end", stop);
  process.stdin.resume();
}
await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_DELAY_MS ?? 0)));
const now = () => new Date().toISOString();
const owner = { pid: process.pid, id: randomUUID(), startedAt: now(), heartbeatAt: now(), host: "127.0.0.1", port, mode };
writeFileSync(lease, JSON.stringify(owner));
setInterval(() => writeFileSync(lease, JSON.stringify({ ...owner, heartbeatAt: now() })), 2000);
createServer((request, response) => {
  const token = readFileSync(tokenPath, "utf8").trim();
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, mode }));
}).listen(port, "127.0.0.1");
