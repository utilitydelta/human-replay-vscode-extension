// Grammar packages pin peer tree-sitter@^0.21 while the project uses 0.22.
// The peer is advisory (grammars are standalone NAPI addons), but the stale
// ranges make `npm list --production` fail, which breaks `vsce package`.
// Widen them everywhere npm validates: each package's package.json, the main
// lockfile, and the hidden lockfile. Idempotent; runs on postinstall.
const fs = require("fs");
const path = require("path");

const WIDE = ">=0.21.0";
const GRAMMARS = [
  "@tree-sitter-grammars/tree-sitter-markdown",
  "tree-sitter-c-sharp",
  "tree-sitter-html",
  "tree-sitter-python",
  "tree-sitter-typescript",
];

const root = path.join(__dirname, "..");
let touched = 0;

function widen(pkg) {
  const peer = pkg.peerDependencies?.["tree-sitter"];
  if (!peer || peer === WIDE) return false;
  pkg.peerDependencies["tree-sitter"] = WIDE;
  return true;
}

function rewrite(file, mutate) {
  if (!fs.existsSync(file)) return;
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  if (mutate(json)) {
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    touched++;
  }
}

for (const name of GRAMMARS) {
  rewrite(path.join(root, "node_modules", name, "package.json"), widen);
}
for (const lock of ["package-lock.json", "node_modules/.package-lock.json"]) {
  rewrite(path.join(root, lock), (json) => {
    let changed = false;
    for (const name of GRAMMARS) {
      const entry = json.packages?.[`node_modules/${name}`];
      if (entry && widen(entry)) changed = true;
    }
    return changed;
  });
}

if (touched) console.log(`[fix-grammar-peers] widened tree-sitter peer ranges in ${touched} file(s)`);
