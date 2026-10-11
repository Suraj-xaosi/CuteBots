import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAgentEvals } from "./eval-runner.js";

const mode = process.argv.includes("--ci") ? "ci" : "full";
const report = await runAgentEvals(mode);
console.log(JSON.stringify(report, null, 2));
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
if (outputArgument) {
  const outputPath = resolve(outputArgument.slice("--output=".length));
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
if (!report.passed) process.exitCode = 1;
