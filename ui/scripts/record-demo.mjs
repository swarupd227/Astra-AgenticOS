import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "recordings");
const URL = process.env.DEMO_URL || "http://localhost:5173";
const W = 1280, H = 800;

fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function caption(page, text) {
  await page.evaluate((t) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      el.style.cssText =
        "position:fixed;left:0;right:0;bottom:0;z-index:99999;pointer-events:none;" +
        "padding:18px 28px;text-align:center;font-family:Inter,Segoe UI,sans-serif;" +
        "font-size:22px;font-weight:500;color:#fff;" +
        "background:linear-gradient(to top, rgba(5,8,14,.92), rgba(5,8,14,.0));" +
        "text-shadow:0 1px 3px rgba(0,0,0,.6);transition:opacity .25s";
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

async function click(page, selector, timeout = 8000) {
  await page.waitForSelector(selector, { timeout });
  await page.click(selector);
}

async function openArtifact(page, re, label) {
  await caption(page, label);
  const rows = await page.$$(".art-row");
  let opened = false;
  for (const r of rows) {
    const t = await r.innerText();
    if (re.test(t)) { await r.click(); opened = true; break; }
  }
  if (!opened) return;
  await page.waitForSelector("#viewer-backdrop:not([hidden])", { timeout: 8000 }).catch(() => {});
  await sleep(1500);
  await page.evaluate(() => { const b = document.getElementById("viewer-body"); if (b) b.scrollTo({ top: b.scrollHeight * 0.55, behavior: "smooth" }); });
  await sleep(4500);
  await page.evaluate(() => { const b = document.getElementById("viewer-body"); if (b) b.scrollTo({ top: 0, behavior: "smooth" }); });
  await sleep(1500);
  await page.click("#viewer-close").catch(() => {});
  await sleep(1000);
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT_DIR, size: { width: W, height: H } },
  });
  const page = await context.newPage();

  await page.goto(URL, { waitUntil: "networkidle" });
  await sleep(1500);

  await caption(page, "ASTRA AgenticOS — 28 SDLC agents, grounded in your real code");
  await sleep(4500);

  await caption(page, "Pick a project — any local folder or git repo");
  await click(page, "#project-btn");
  await sleep(3500);
  await page.click("#project-btn").catch(() => {});
  await sleep(1200);

  await caption(page, "Agents are grouped by SDLC area");
  await page.evaluate(() => { const s = document.querySelector(".sidebar"); if (s) s.scrollTo({ top: s.scrollHeight, behavior: "smooth" }); });
  await sleep(4500);
  await page.evaluate(() => { const s = document.querySelector(".sidebar"); if (s) s.scrollTo({ top: 0, behavior: "smooth" }); });
  await sleep(1500);

  await caption(page, "Impact Analysis — what breaks if I change TaxService?");
  await click(page, '.agent-card[data-id="impact-analysis"]');
  await sleep(2500);

  await caption(page, "One click runs the agent against the real codebase");
  await click(page, ".suggest-card");
  await sleep(7000);

  const streamCaps = [
    "It calls real tools — analyze_impact, find_references — on the code",
    "Tool calls run against the real reference graph (no guessing)",
    "The answer streams in live, grounded with file:line evidence",
    "Risk rating, dependent files and a targeted re-test plan",
  ];
  for (const c of streamCaps) {
    await caption(page, c);
    await page.evaluate(() => { const c = document.querySelector(".conversation"); if (c) c.scrollTo({ top: c.scrollHeight, behavior: "smooth" }); });
    await sleep(14000);
  }

  await caption(page, "Every run is saved as a downloadable artifact");
  await click(page, "#artifacts-btn");
  await sleep(3000);

  await openArtifact(page, /impact-TaxService/i, "Impact report — the full grounded analysis");
  await openArtifact(page, /config-audit/i, "Config & Secrets audit — secrets and insecure settings");
  await openArtifact(page, /orchestration-report/i, "Orchestrator report — agents planned, delegated, synthesised");

  await page.click("#drawer-close").catch(() => {});
  await sleep(800);

  await caption(page, "28 agents · 11 SDLC areas · one MCP server · pointable at any repo");
  await sleep(5000);

  const videoPath = await page.video().path();
  await context.close();
  await browser.close();

  const finalPath = path.join(OUT_DIR, "astra-agenticos-demo.webm");
  try { fs.renameSync(videoPath, finalPath); } catch { fs.copyFileSync(videoPath, finalPath); }
  const sz = (fs.statSync(finalPath).size / 1048576).toFixed(1);
  console.log(`VIDEO_SAVED ${finalPath} (${sz} MB)`);
}

main().catch((e) => { console.error("RECORD_FAILED", e); process.exit(1); });
