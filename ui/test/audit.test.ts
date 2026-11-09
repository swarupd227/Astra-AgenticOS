/**
 * Pins the static before/after audit in src/audit.ts.
 *
 *   npm test
 *
 * Every check is a pattern over text, so the value of these cases is where each one
 * draws its line: the shapes that must be flagged, and the near-misses that must stay
 * quiet — a check that cries wolf on clean code gets ignored.
 */
import { auditChange, formatAudit, isTestPath, proposalsWithoutTests } from "../src/audit.js";

let failures = 0;
const fail = (msg: string) => { console.error(msg); failures++; };
const dim = (a: ReturnType<typeof auditChange>, name: string) => a.dimensions.find((d) => d.name === name)!;
const newCount = (before: string, after: string, name: string, path = "x.cs") =>
  dim(auditChange(path, "modify", before, after), name).introduced.length;

// --- secrets ------------------------------------------------------------------------
const SECRET_FLAG: Array<[string, string]> = [
  ["hardcoded password", 'var password = "Sup3rSecretValue";'],
  ["api key in config", 'apiKey: "abcd1234efgh5678"'],
  ["client secret (name has a prefix)", 'client_secret = "9f8e7d6c5b4a"'],
  ["aws key id", "const id = AKIAIOSFODNN7EXAMPLE;"],
  ["private key block", "-----BEGIN RSA PRIVATE KEY-----"],
];
for (const [label, line] of SECRET_FLAG)
  if (newCount("", line + "\n", "Secrets") !== 1) fail(`SECRET FLAG | ${label}`);

const SECRET_QUIET: Array<[string, string]> = [
  ["placeholder", 'password = "changeme123"'],
  ["template variable", 'token = "${API_TOKEN}"'],
  ["angle placeholder", 'secret = "<your-secret-here>"'],
  ["read from environment", "const key = process.env.API_KEY;"],
  ["too short to be a secret", 'password = "abc"'],
  ["a different word that contains 'token'", 'tokenizer = "wordpiece-model"'],
];
for (const [label, line] of SECRET_QUIET)
  if (newCount("", line + "\n", "Secrets") !== 0) fail(`SECRET QUIET | ${label}`);

// A pre-existing secret that only moves is not something this change introduced.
{
  const a = 'x = 1;\npassword = "Sup3rSecretValue";\n';
  const b = 'password = "Sup3rSecretValue";\nx = 1;\n';
  const d = dim(auditChange("a.cs", "modify", a, b), "Secrets");
  if (d.introduced.length !== 0 || d.resolved !== 0) fail("SECRET | a moved line must be neither new nor resolved");
}
// Removing one is reported as resolved.
{
  const d = dim(auditChange("a.cs", "modify", 'password = "Sup3rSecretValue";\n', "x = 1;\n"), "Secrets");
  if (d.resolved !== 1 || d.status !== "ok") fail("SECRET | removed secret should count as resolved");
}
// The audit must never carry the value itself — it is written to disk and shown in chat.
{
  const a = auditChange("a.cs", "create", "", 'password = "Sup3rSecretValue";\n');
  if (JSON.stringify(a).includes("Sup3rSecretValue") || formatAudit(a).includes("Sup3rSecretValue"))
    fail("SECRET | the secret value leaked into the audit");
}

// --- swallowed errors -----------------------------------------------------------------
const SWALLOW_FLAG: Array<[string, string, string]> = [
  ["C# empty catch", "try { Do(); } catch (Exception) { }", "a.cs"],
  ["multi-line empty catch", "try {\n  Do();\n} catch (e) {\n}\n", "a.ts"],
  ["JS catch without binding", "try { x(); } catch {}", "a.js"],
  ["swallowed promise", "fetch(u).catch(() => {});", "a.ts"],
  ["python except pass", "try:\n    f()\nexcept Exception:\n    pass\n", "a.py"],
  ["ruby empty rescue", "begin\n  f\nrescue => e\nend\n", "a.rb"],
  ["go error ignored", "if err != nil {\n}\n", "a.go"],
  // Found by a live run: the agent's empty catch held only a TODO comment.
  ["catch holding only a line comment", "try { f(); }\ncatch\n{\n    // TODO: handle failures\n}\n", "a.cs"],
  ["catch holding only a block comment", "try { f(); } catch (Exception) { /* ignore */ }", "a.java"],
  ["python except with only a comment, then pass", "try:\n    f()\nexcept Exception:\n    # ignore\n    pass\n", "a.py"],
  ["swallowed promise holding a comment", "p.catch(() => { /* ignore */ });", "a.ts"],
];
for (const [label, code, p] of SWALLOW_FLAG)
  if (newCount("", code, "Error handling", p) < 1) fail(`SWALLOW FLAG | ${label}`);

const SWALLOW_QUIET: Array<[string, string, string]> = [
  ["catch that logs", "try { f(); } catch (e) { logger.error(e); }", "a.ts"],
  ["catch that rethrows", "try { f(); } catch (e) { throw; }", "a.cs"],
  ["python except that handles", "try:\n    f()\nexcept ValueError:\n    return None\n", "a.py"],
  ["go error returned", "if err != nil {\n    return err\n}\n", "a.go"],
  ["catch with a comment AND real handling", "try { f(); } catch (e) { // report it\n    logger.error(e); }", "a.ts"],
  ["python except with a comment and a real body", "try:\n    f()\nexcept ValueError:\n    # fall back\n    return 0\n", "a.py"],
];
for (const [label, code, p] of SWALLOW_QUIET)
  if (newCount("", code, "Error handling", p) !== 0) fail(`SWALLOW QUIET | ${label}`);

// --- TODO debt ------------------------------------------------------------------------
{
  const before = "// TODO: tidy\nint a;\n";
  const after = "// TODO: tidy\nint a;\n// FIXME: handle null\n";
  const d = dim(auditChange("a.cs", "modify", before, after), "TODO debt");
  if (d.introduced.length !== 1 || d.introduced[0].line !== 3) fail("TODO | only the new marker is introduced");
  if (d.before !== 1 || d.after !== 2) fail("TODO | before/after counts");
  if (newCount("", "int todoList;\nvar xxxx = 1;\n", "TODO debt") !== 0) fail("TODO | a word that only contains the marker");
}

// --- comment density --------------------------------------------------------------------
{
  const code = Array.from({ length: 10 }, (_, i) => `int v${i} = ${i};`).join("\n");
  const noisy = Array.from({ length: 10 }, (_, i) => `// set v${i}\nint v${i} = ${i};\n// done v${i}`).join("\n");
  if (dim(auditChange("a.cs", "modify", code, noisy), "Comment density").status !== "attention")
    fail("DENSITY | a file that is two-thirds new comments should be flagged");
  if (dim(auditChange("a.cs", "modify", code, code + "\n// one note\nint z;"), "Comment density").status !== "ok")
    fail("DENSITY | one added comment is not noise");
  if (dim(auditChange("a.cs", "create", "", "// header\n// header\n// header\n// header\n// header\nint a;\n"), "Comment density").status !== "attention")
    fail("DENSITY | a new file that is mostly comments");
  if (dim(auditChange("data.json", "modify", "{}", '{"a":1}'), "Comment density").status !== "info")
    fail("DENSITY | unknown file types are reported as not assessed");
}

// --- the shape of the result -------------------------------------------------------------
{
  const a = auditChange("a.cs", "create", "", "int a;\n");
  const names = a.dimensions.map((d) => d.name).join(",");
  if (names !== "Secrets,Error handling,TODO debt,Comment density") fail(`SHAPE | dimensions: ${names}`);
  for (const must of ["Build", "Scanner-based security", "Performance"])
    if (!a.notAssessed.some((n) => n.name === must)) fail(`SHAPE | ${must} must be listed as not assessed`);
  const text = formatAudit(a);
  if (!text.includes("nothing was run")) fail("SHAPE | the audit must say nothing was run");
  if (!text.includes("Not assessed:")) fail("SHAPE | the audit must list what it did not assess");
}

// --- tests alongside the change ----------------------------------------------------------
const TEST_PATHS: Array<[string, boolean]> = [
  ["src/Services/TaxServiceTests.cs", true],
  ["tests/unit/tax.py", true],
  ["src/tax.test.ts", true],
  ["pkg/tax_test.go", true],
  ["test_tax.py", true],
  ["src/__tests__/tax.js", true],
  ["src/Services/TaxService.cs", false],
  ["src/contest.ts", false],
  ["docs/latest.md", false],
];
for (const [p, want] of TEST_PATHS) if (isTestPath(p) !== want) fail(`TESTPATH | ${p}: expected ${want}`);

const SETS: Array<[string, string[], string[]]> = [
  ["source with no test", ["src/a.cs"], ["src/a.cs"]],
  ["source with its test", ["src/a.cs", "tests/aTests.cs"], []],
  ["only a test", ["tests/aTests.cs"], []],
  ["docs only", ["README.md"], []],
  ["two sources, one unrelated test", ["a.go", "b.go", "c_test.go"], []],
  ["nothing proposed", [], []],
];
for (const [label, paths, want] of SETS)
  if (JSON.stringify(proposalsWithoutTests(paths)) !== JSON.stringify(want)) fail(`NOTESTS | ${label}`);

console.log(`change audit — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
