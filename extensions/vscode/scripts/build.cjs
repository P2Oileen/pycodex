const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

fs.rmSync("out", { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "."], { stdio: "inherit" });
const markdownRoot = path.dirname(require.resolve("markdown-it/package.json"));
fs.copyFileSync(path.join(markdownRoot, "dist/markdown-it.min.js"), "out/markdown-it.min.js");
const bundledLicenses = {
  "markdown-it": "LICENSE",
  "entities": "LICENSE",
  "linkify-it": "LICENSE",
  "mdurl": "LICENSE",
  "punycode.js": "LICENSE-MIT.txt",
  "uc.micro": "LICENSE.txt",
};
fs.writeFileSync("out/markdown-it.LICENSE", Object.entries(bundledLicenses).map(
  ([name, file]) => `${name}\n\n${fs.readFileSync(path.join("node_modules", name, file), "utf8")}`,
).join("\n\n"));
