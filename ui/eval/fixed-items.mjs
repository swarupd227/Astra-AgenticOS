// Fixed-item sample for grading a BRD: choose N named source items ONCE, before any run, then for each run pick the
// requirement that covers each item. Runs are then compared item for item, whatever IDs they use.
//
//   node fixed-items.mjs init <source.md> <items.json> [N=30]
//       Items are the "####" sub-headings under each area's "Requirement Breakdown" heading, spread evenly over the source.
//   node fixed-items.mjs pick <items.json> <brd.md> <outDir>
//       Writes <outDir>/fixed1-3.md (10 requirements each, one per grader) and <outDir>/fixed-map.json.
//
// Matching: a requirement covers an item when its Source Reference names the item's heading (10 points) and/or quotes the
// item's text (up to 5). Minimum 3. Fixed rules, so a score cannot hide an error:
//   - several requirements cite an item: take the best score (lowest ID on a tie) and list the others for the graders;
//   - one requirement is the best match for two or more items: grade it once, flag a POSSIBLE MERGE (the merged-items failure);
//   - no requirement reaches the minimum: the item is DROPPED and counts as a FAIL.
import fs from "node:fs";
import path from "node:path";

const plain = (s) => s.replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim();
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 3));
const idNum = (id) => Number(id.replace(/\D/g, ""));
const segs = (s) => s.replace(/[*_`]/g, "").split(/[›>—–:“”"|;/()\[\]]+|\s-\s/).map(norm).filter(Boolean);
const [, , cmd, a, b, c] = process.argv;

if (cmd === "init") {
  const N = Number(c ?? 30);
  const src = fs.readFileSync(a, "utf8").split(/\r?\n/);
  // Areas are the "##" headings, or the "#" headings when the source has no "##" (as areaHeadings does).
  const areaLevel = src.some((l) => /^##\s/.test(l)) ? 2 : 1;
  let area = "", breakdownLevel = 0;
  const all = [];
  src.forEach((l, i) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(l);
    if (!m) return;
    const level = m[1].length, title = plain(m[2]);
    if (level <= areaLevel) { area = level === areaLevel ? title : ""; breakdownLevel = 0; return; }
    if (/requirement breakdown/i.test(title)) { breakdownLevel = level; return; }
    if (breakdownLevel && level <= breakdownLevel) { breakdownLevel = 0; return; }
    if (breakdownLevel && level === breakdownLevel + 1 && area) {
      const next = src.slice(i + 1).findIndex((x) => /^#{1,6}\s/.test(x));
      const body = src.slice(i + 1, i + 1 + (next < 0 ? 11 : Math.min(next, 11))).map(plain).filter(Boolean).join(" ");
      all.push({ area, item: title, text: body.slice(0, 200) });
    }
  });
  if (all.length < N) { console.error(`only ${all.length} breakdown items, need ${N}`); process.exit(1); }
  const pick = Array.from({ length: N }, (_, k) => all[Math.floor((k * all.length) / N)]);
  fs.writeFileSync(b, JSON.stringify(pick, null, 1));
  console.log(`${all.length} breakdown items; ${N} chosen and frozen in ${b}`);
  process.exit(0);
}

if (cmd !== "pick") { console.error("usage: init <source.md> <items.json> [N] | pick <items.json> <brd.md> <outDir>"); process.exit(1); }
const items = JSON.parse(fs.readFileSync(a, "utf8"));
const md = fs.readFileSync(b, "utf8");
const start = /^(?:#{3,6}\s+(?:\*\*)?REQ-\d+|(?:\*\*)REQ-\d+(?:\*\*)\s*$)/;
const reqs = []; let cur = null;
for (const l of md.split(/\r?\n/)) {
  if (start.test(l)) { if (cur) reqs.push(cur.join("\n").trim()); cur = [l]; continue; }
  if (cur && /^#{1,6}\s/.test(l)) { reqs.push(cur.join("\n").trim()); cur = null; continue; }
  if (cur) cur.push(l);
}
if (cur) reqs.push(cur.join("\n").trim());
const parsed = reqs.map((text) => {
  const ref = /\*\*Source Reference:\*\*([\s\S]*?)(?=\n\s*\n\s*\*\*[A-Z]|$)/.exec(text)?.[1] ?? "";
  return { id: text.match(/REQ-\d+/)[0], text, ref: ` ${norm(ref)} `, refSegs: segs(ref), refWords: words(ref) };
});

// Heading match: 10 when the item heading is a whole segment of the reference path (bounded by › — : / quotes and the
// like, or the ends), so "Credit Memo" does not take full credit from "Credit Memo Approval"; 2 when only contained
// (below the minimum of 3, so a contained heading counts only with the item's own text quoted as well).
function headScore(r, headSegs, head) {
  const n = headSegs.length;
  for (let i = 0; i + n <= r.refSegs.length; i++) if (headSegs.every((s, k) => r.refSegs[i + k] === s)) return 10;
  return r.ref.includes(` ${head} `) ? 2 : 0;
}

const map = items.map((it) => {
  const head = norm(it.item), headSegs = segs(it.item), body = words(it.text);
  const scored = parsed.map((r) => {
    let shared = 0; for (const w of body) if (r.refWords.has(w)) shared++;
    return { id: r.id, score: headScore(r, headSegs, head) + (body.size ? (shared / body.size) * 5 : 0) };
  }).filter((s) => s.score >= 3).sort((x, y) => y.score - x.score || idNum(x.id) - idNum(y.id));
  const top = scored[0];
  // Alternatives: other requirements that also name the item's heading, or score as high as the pick.
  const alternatives = top ? scored.slice(1).filter((s) => s.score >= Math.min(top.score, 10)).map((s) => s.id) : [];
  return { item: `${it.area} › ${it.item}`, picked: top?.id ?? null, alternatives };
});

const byReq = new Map();
for (const m of map) if (m.picked) byReq.set(m.picked, [...(byReq.get(m.picked) ?? []), m.item]);
const merges = [...byReq].filter(([, its]) => its.length > 1);
const dropped = map.filter((m) => !m.picked).map((m) => m.item);

// Grade each picked requirement once; tell the grader which source item(s) it must cover and what the alternatives are.
const entries = [...byReq].map(([id, its]) => {
  const alts = [...new Set(map.filter((m) => m.picked === id).flatMap((m) => m.alternatives))];
  const note = [`> Source item(s) to check: ${its.join("; ")}`];
  if (its.length > 1) note.push(`> POSSIBLE MERGE: this one requirement is the best match for ${its.length} source items. Check each is fully covered.`);
  if (alts.length) note.push(`> Other requirements citing the same item: ${alts.join(", ")}. Check them only if this one leaves part of the item out.`);
  return note.join("\n") + "\n\n" + parsed.find((r) => r.id === id).text;
});
fs.mkdirSync(c, { recursive: true });
const per = Math.ceil(entries.length / 3);
for (let s = 0; s < 3; s++) fs.writeFileSync(path.join(c, `fixed${s + 1}.md`), entries.slice(s * per, s * per + per).join("\n\n=====\n\n") + "\n");
// Totals are always out of the full item count: each dropped item is a FAIL the graders never see.
const scoring = { denominator: map.length, droppedAsFail: dropped.length, graded: entries.length };
fs.writeFileSync(path.join(c, "fixed-map.json"), JSON.stringify({ scoring, map, merges: merges.map(([id, its]) => ({ id, items: its })), dropped }, null, 1));

console.log(`${map.length - dropped.length}/${map.length} items matched; ${entries.length} requirements to grade. ` +
  `Report totals out of ${map.length}: grader FAILs + ${dropped.length} dropped.`);
const withAlts = map.filter((m) => m.alternatives.length);
if (withAlts.length) console.log(`${withAlts.length} item(s) with alternatives (best score taken, lowest ID on a tie):`, withAlts.map((m) => `${m.picked}[+${m.alternatives.join(",")}]`).join(" "));
if (merges.length) console.log("POSSIBLE MERGES:", merges.map(([id, its]) => `${id} ← ${its.join(" + ")}`).join(" | "));
if (dropped.length) console.log("DROPPED (count as FAIL):", dropped.join(" | "));
