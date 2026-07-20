/** Test helper that records entry and exit from the artifact lock. */
import { appendFileSync } from "node:fs";

const [eventPath, id, delayValue] = process.argv.slice(2);
const delayMs = Number(delayValue);
appendFileSync(eventPath, `${id}:start\n`, "utf8");
await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
appendFileSync(eventPath, `${id}:end\n`, "utf8");
