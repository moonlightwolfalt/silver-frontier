// Usage: bun run pretty [dir]   (default: mope-dump/site)
// Formats every .html/.js/.css/.json file under dir in place with Prettier.
import { Glob } from "bun";
import { readFile, writeFile } from "node:fs/promises";
import * as prettier from "prettier";

const dir = process.argv[2] ?? "mope-dump/site";
let done = 0;
for await (const file of new Glob("**/*.{html,js,css,json}").scan({ cwd: dir, absolute: true })) {
  const src = await readFile(file, "utf8");
  try {
    const out = await prettier.format(src, { filepath: file, printWidth: 100 });
    if (out !== src) await writeFile(file, out);
    done++;
  } catch (e) {
    console.warn("skip", file, String(e).split("\n")[0]);
  }
}
console.log(`formatted ${done} files in ${dir}`);
