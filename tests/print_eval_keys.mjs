import fs from "fs";
const tests = JSON.parse(fs.readFileSync("tests/nexus_100_eval_pack.json", "utf8"));
for (const t of tests) {
  const line = t.evaluatorKey.replace(/\r?\n/g, " ").trim();
  console.log(`[${t.id}] ${line}`);
}
