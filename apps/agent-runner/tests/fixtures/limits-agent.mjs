// Test fixture: an "agent" that reports the limits it runs under and whether growing a file past
// the file size limit is refused, as JSON in $FIXTURE_REPORT. Stays up until its stdin closes.
import { openSync, ftruncateSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const report = { limits: readFileSync("/proc/self/limits", "utf8") };
const file = openSync(path.join(process.env.HOME, "big"), "w");
try {
  ftruncateSync(file, Number(process.env.FIXTURE_TRUNCATE_TO));
  report.truncate = "ok";
} catch (error) {
  report.truncate = error.code;
}
writeFileSync(process.env.FIXTURE_REPORT, JSON.stringify(report));
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
