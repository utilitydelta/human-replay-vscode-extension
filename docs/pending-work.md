# Pending work

## Tree-sitter runtime + grammar upgrade

The bundled grammars lag the languages they parse, and the gap now has a
proven failure mode: `tree-sitter-c-sharp@0.21.3` rejects C#12 primary
constructors on classes and structs (`public struct Foo(string x);` parses
with ERROR nodes), while records (C#9/10) parse fine. Tree-sitter grammars
are community-maintained re-implementations — Microsoft ships Roslyn, not
these — so every new language version waits on a volunteer hand-encoding it.

The engine tolerates the gap honestly since the dirty-parse fix: an erroring
parse yields no verdict, so unknown syntax degrades to human-ratified
fallback surfaces (cursor ghost, block ghost, patch hunks) instead of
dead-ending or anchoring on a poisoned container key. Replay still lands
exact bytes; you just get fewer AST-level Tabs.

Upgrading is a migration, not a version bump. Probed empirically (2026-07-03):

- Latest grammar is 0.23.5; it wants a newer `tree-sitter` native runtime.
- That runtime fails to compile against Node 24 headers (`#error "C++20 or
  later required"` from its gyp config).
- The 0.23.x grammar bindings moved to an ESM loader with top-level await —
  `require()` fails, and the whole stack (extension bundle, test oracles,
  `validate-guide.js`) is CJS with grammars externalized in every esbuild
  call.

Scope when funded: bump the runtime and all eight grammars together, adapt
the CJS externals/loading (or move to dynamic `import()`), re-run the full
oracle suite, and re-probe the C#12 corpus. Trigger: sandbox agents emitting
modern syntax (primary constructors, newer TS) often enough that block-ghost
fallbacks noticeably replace walks.

## Cross-file context for FIM

Both FIM model sizes invent members (`cart.Filter`, `.Price`) because the
prompt carries only the current file — `Cart.cs` never enters the context.
Benchmarked on the demo repo: model size sharpens the code shape but cannot
fix missing type knowledge. When funded: weave the definitions of symbols
referenced near the caret (tree-sitter already resolves them per language)
into the prompt the same way replay notes weave in — prompt-only, no buffer
bytes, capped by prefixChars.
