// Temporary env verification script for R3 run
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Load .env manually
function loadEnv() {
  const p = resolve(process.cwd(), ".env");
  if (!existsSync(p)) {
    console.log("NO .env file at", p);
    return;
  }
  const txt = readFileSync(p, "utf-8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) {
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[m[1]]) {
        process.env[m[1]] = val;
      }
    }
  }
}

loadEnv();

const ark = process.env.ARK_API_KEY || process.env.VOLCES_API_KEY || "";
const glm = process.env.GLM_API_KEY || "";

console.log("ARK_API_KEY present:", ark.length > 0, "len:", ark.length);
console.log("GLM_API_KEY present:", glm.length > 0, "len:", glm.length);
console.log("dist-eval/novelbench/index.js exists:", existsSync(".pi/extensions/novel-studio/dist-eval/novelbench/index.js"));
console.log("generation-input ch1106 exists:", existsSync("data/novelbench/datasets/generation-inputs/nb3r-v1-01727287bd911ec3-ch1106.txt"));
console.log("case-a.jsonl exists:", existsSync("data/novelbench/demo-3/case-a.jsonl"));
console.log("case-a-glm-r3 exists (should be false):", existsSync("data/novelbench/demo-3/case-a-glm-r3"));
