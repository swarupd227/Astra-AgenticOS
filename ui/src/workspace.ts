import fs from "node:fs";
import path from "node:path";

/**
 * What is allowed to land on disk when a project arrives.
 *
 * A user hit the upload cap with a 400 MB zip. Almost all of it was build output —
 * which the code index already refuses to look at, so it would have been transferred,
 * written to the shared /home volume, and never read by anything. Raising the cap
 * would have made that worse rather than better.
 */

/**
 * Directories the code index never opens — kept in step with the ignore list in
 * `CodeIndex.cs`. Nothing inside them is visible to any agent.
 */
export const NEVER_INDEXED = [
  "bin", "obj", "packages", ".git", ".vs", "node_modules", "TestResults",
  "dist", "build", ".angular", ".next", "target", "out",
];

/** Exclusion patterns for `unzip -x`: the directory at the root, and at any depth. */
export function unzipExcludeArgs(): string[] {
  return ["-x", ...NEVER_INDEXED.flatMap((d) => [`${d}/*`, `*/${d}/*`])];
}

/**
 * Whole-segment match only. `bin.cs` is a source file and `Cabinet/` is a source
 * folder; substring matching would delete both and hide real code from every agent.
 */
export function isNeverIndexed(dirName: string): boolean {
  return NEVER_INDEXED.includes(dirName);
}

/**
 * Delete build output from an extracted project, and report what went.
 *
 * `unzip -x` does the same job more cheaply during extraction, but a mistyped pattern
 * there fails silently — and the two failure modes are not equally bad. Extracting
 * junk merely wastes space; excluding source would quietly hide code. Running this
 * afterwards makes the shell patterns an optimisation rather than something
 * correctness rests on.
 */
/** Files anywhere under a directory. Zero means the extraction produced nothing usable. */
export function countFiles(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  try { walk(dir); } catch { /* unreadable is the same as empty for this purpose */ }
  return n;
}

export function pruneUnindexed(dir: string): { removed: number; bytes: number } {
  let removed = 0, bytes = 0;

  const sizeOf = (d: string): number => {
    let total = 0;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      try { total += e.isDirectory() ? sizeOf(full) : fs.statSync(full).size; } catch { /* vanished */ }
    }
    return total;
  };

  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;              // a *file* called `bin` is source
      const full = path.join(d, e.name);
      if (isNeverIndexed(e.name)) {
        try {
          bytes += sizeOf(full);
          fs.rmSync(full, { recursive: true, force: true });
          removed++;
        } catch { /* a locked file is not worth failing the whole upload over */ }
      } else {
        walk(full);
      }
    }
  };

  try { walk(dir); } catch { /* best effort — a partial prune is still a win */ }
  return { removed, bytes };
}
