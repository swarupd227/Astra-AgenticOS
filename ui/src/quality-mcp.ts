/**
 * The quality gate for tools outside the web app (see quality-gate.ts).
 *
 *   As an MCP server (stdio), for Claude Code or any MCP client:   tsx src/quality-mcp.ts
 *   As a command, for a CI job:   tsx src/quality-mcp.ts check <document> <source…> [--task <file>]
 *                                 exits 0 with no findings, 1 with findings, 2 when it could not run.
 *
 * Files are read from GATE_ROOT (default: the folder it is started in). GOLDEN_DIR and GOLDEN_ITEMS (comma-separated)
 * let it read the Golden Repository items a document cites. Nothing is written and nothing is sent anywhere.
 */
import { checkDocument, compareSources, reviewInstructions, type GateOptions } from "./quality-gate.js";

const options: GateOptions = {
  root: process.env.GATE_ROOT || process.cwd(),
  goldenDir: process.env.GOLDEN_DIR || undefined,
  goldenItems: process.env.GOLDEN_ITEMS ? process.env.GOLDEN_ITEMS.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) : undefined,
};

const sources = { type: "array", items: { type: "string" }, description: "The .md or .txt documents the requirements were written from, or folders of them. Cite each in the document by its path or its file name in backticks." };
const taskFile = { type: "string", description: "The file holding the task or prompt the document was written for, if there is one. It sets scope and can be cited as `task prompt`." };

const TOOLS = [
  {
    name: "check_document",
    description: "Check a requirements document against the documents it was written from: citations that are not in the cited source, quotes that are not verbatim, source items no requirement covers, invented roles and dependencies, strengthened wording, lists cut short, and more. Deterministic, no model call. Run it after writing or editing the document; fix or explain each finding and run it again.",
    inputSchema: { type: "object" as const, properties: { document: { type: "string", description: "The requirements document (Markdown)." }, sources, task_file: taskFile }, required: ["document", "sources"] },
  },
  {
    name: "compare_sources",
    description: "Before writing: find terms the source documents define in unlike words, so each can be recorded as a conflict instead of silently chosen between.",
    inputSchema: { type: "object" as const, properties: { sources, task_file: taskFile }, required: ["sources"] },
  },
  {
    name: "review_instructions",
    description: "The brief for an independent reviewer of a requirements document: what the wording checks cannot judge. Give it to a subagent that did not write the document.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

function call(name: string, args: Record<string, unknown>): string {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);
  const task = typeof args.task_file === "string" && args.task_file ? args.task_file : undefined;
  if (name === "check_document") return checkDocument(options, { document: String(args.document ?? ""), sources: list(args.sources), taskFile: task }).text;
  if (name === "compare_sources") return compareSources(options, { sources: list(args.sources), taskFile: task });
  if (name === "review_instructions") return reviewInstructions();
  throw new Error(`unknown tool: ${name}`);
}

function command(argv: string[]): number {
  const t = argv.indexOf("--task");
  const taskFile = t >= 0 ? argv[t + 1] : undefined;
  const [document, ...rest] = argv.filter((_, i) => t < 0 || (i !== t && i !== t + 1));
  if (!document || !rest.length || (t >= 0 && !taskFile)) {
    console.error("usage: check <document> <source…> [--task <file>]");
    return 2;
  }
  try {
    const r = checkDocument(options, { document, sources: rest, taskFile });
    console.log(r.text);
    return r.findings.length ? 1 : 0;
  } catch (e) {
    console.error(`quality gate could not run: ${(e as Error).message}`);
    return 2;
  }
}

if (process.argv[2] === "check") process.exitCode = command(process.argv.slice(3));
else {
  // Loaded only to serve: the SDK took 17 s to load from a synced folder, which a CI command has no reason to pay.
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const server = new Server({ name: "agenticos-quality-gate", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try { return { content: [{ type: "text" as const, text: call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>) }] }; }
    catch (e) { return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] }; }
  });
  await server.connect(new StdioServerTransport());
}
