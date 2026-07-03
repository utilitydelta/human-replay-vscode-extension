const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  // Native node addons load from node_modules at runtime. The .vsix ships the
  // production node_modules with per-platform NAPI prebuilds (vsce --target,
  // one package per OS/arch); .vscodeignore strips the sources and wasm.
  external: ["vscode", "tree-sitter", "tree-sitter-rust", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-python", "@tree-sitter-grammars/tree-sitter-markdown", "tree-sitter-html", "tree-sitter-css"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: !watch,
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("watching...");
  } else {
    await esbuild.build(options);
    console.log("build complete");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
