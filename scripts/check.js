import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(`${dir}/${e.name}`)
      : e.name.endsWith(".js")
        ? [`${dir}/${e.name}`]
        : [],
  );
}
let failed = false;
for (const file of ["src", "public/js", "scripts", "tests"].flatMap((d) =>
  walk(d),
)) {
  const r = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });
  if (r.status) failed = true;
}
if (failed) process.exit(1);
console.log("All JavaScript syntax checks passed.");
