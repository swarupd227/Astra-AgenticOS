/**
 * Pins per-project Golden visibility in src/golden.ts.
 *
 *   npm test
 *
 * A scoped item must be invisible to every other project in EVERY selection mode —
 * including "all", which is how client material loaded for one project used to reach the rest.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoldenStore } from "../src/golden.js";

let failures = 0;
const fail = (m: string) => { console.error(m); failures++; };
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golden-scope-"));
const store = new GoldenStore(dir);

const make = (title: string, extra: Record<string, unknown> = {}) =>
  store.create({ title, kind: "reference", status: "published", content: `${title} body`, tags: ["client"], ...extra });

const open = await make("Org standard");
const scopedA = await make("Client A glossary", { scope: "project-a" });

const ids = (items: { id: string }[]) => items.map((i) => i.id).sort();

eq("the owning project sees both", ids(store.selectedFor({ mode: "all" }, "project-a")), ids([open, scopedA]));
eq("another project in 'all' mode sees only the organisation-wide item", ids(store.selectedFor({ mode: "all" }, "project-b")), ids([open]));
eq("a project with no selection recorded behaves like 'all'", ids(store.selectedFor(undefined, "project-b")), ids([open]));
eq("a call that names no project sees no scoped item", ids(store.selectedFor({ mode: "all" })), ids([open]));
eq("a subset by tag still cannot reach another project's item",
  ids(store.selectedFor({ mode: "subset", tags: ["client"] }, "project-b")), ids([open]));
eq("a subset by explicit id still cannot reach another project's item",
  ids(store.selectedFor({ mode: "subset", itemIds: [scopedA.id] }, "project-b")), []);
eq("the owning project can select its own scoped item by id",
  ids(store.selectedFor({ mode: "subset", itemIds: [scopedA.id] }, "project-a")), ids([scopedA]));

// Scope can be added to an existing item, and cleared to make it organisation-wide again.
const patched = await store.update(open.id, { scope: "project-b" });
eq("scope can be set on an existing item", patched.scope, "project-b");
eq("…after which other projects lose it", ids(store.selectedFor({ mode: "all" }, "project-a")), ids([scopedA]));
const cleared = await store.update(open.id, { scope: "" });
eq("an empty scope clears it", cleared.scope, undefined);
eq("…and the item is organisation-wide again", ids(store.selectedFor({ mode: "all" }, "project-a")), ids([open, scopedA]));

// Editing something else must not touch scope.
const edited = await store.update(scopedA.id, { title: "Client A glossary (v2)" });
eq("an edit that does not mention scope leaves it alone", edited.scope, "project-a");

// Scope survives a reload from disk.
eq("scope is persisted", new GoldenStore(dir).get(scopedA.id)?.scope, "project-a");

fs.rmSync(dir, { recursive: true, force: true });
console.log(`golden project scope — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
