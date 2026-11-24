import { parseArgs } from "node:util";
import { configFromEnv, prepareDirectories } from "./config.ts";
import { lockDatabasePath, openDatabase, verifyDatabase } from "./database.ts";
import { activeLibrary } from "./library.ts";
import { findTools } from "./codec.ts";
import { Worker } from "./worker.ts";
import { applicationServer } from "./http.ts";

async function main() {
  const { positionals } = parseArgs({ allowPositionals: true });
  if (
    positionals.length > 1 ||
    !["run", "check"].includes(positionals[0] ?? "run")
  )
    throw new Error("Usage: node src/cli.ts [run|check]");
  const config = await prepareDirectories(configFromEnv());
  const unlock = lockDatabasePath(config.database);
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(config.database);
    verifyDatabase(db);
    activeLibrary(db, config.source);
    const tools = await findTools(config);
    if (positionals[0] === "check") {
      console.log("Database, directories, and codecs are ready");
      db.close();
      unlock();
      return;
    }
    const worker = new Worker(db, config, tools);
    await worker.initialize();
    const server = applicationServer(db, config, worker);
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    console.log("CBZXL is ready at http://" + config.host + ":" + config.port);
    worker.wake();
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      server.close();
      server.closeIdleConnections();
      await worker.close();
      db!.close();
      unlock();
    };
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
  } catch (error) {
    db?.close();
    unlock();
    throw error;
  }
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
