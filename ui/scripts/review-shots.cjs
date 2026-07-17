const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const OUT = process.env.SHOT_DIR || path.join(__dirname, "..", "review-shots");
const URL = process.env.DEMO_URL || "http://localhost:5173";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  let n = 0;
  const shot = async (name) => {
    n++;
    const f = path.join(OUT, `${String(n).padStart(2, "0")}-${name}.png`);
    await page.screenshot({ path: f });
    console.log("shot", path.basename(f));
  };

  await page.goto(URL, { waitUntil: "networkidle" });
  await sleep(2000);
  await shot("landing-dark");

  await page.evaluate(() => { const s = document.querySelector(".sidebar"); if (s) s.scrollTo({ top: s.scrollHeight }); });
  await sleep(900);
  await shot("sidebar-bottom");
  await page.evaluate(() => { const s = document.querySelector(".sidebar"); if (s) s.scrollTo({ top: 0 }); });

  await page.click("#project-btn"); await sleep(700);
  await shot("project-menu");
  await page.click("#pm-new").catch(() => {}); await sleep(700);
  await shot("new-project-local");
  await page.click('.seg-btn[data-type="git"]').catch(() => {}); await sleep(500);
  await shot("new-project-git");
  await page.click("#np-cancel").catch(() => {}); await sleep(400);

  await page.click("#settings-btn"); await sleep(700);
  await shot("settings-modal");
  await page.click("#set-cancel"); await sleep(400);

  await page.click('.agent-card[data-id="impact-analysis"]'); await sleep(1200);
  await shot("agent-intro");

  await page.click(".suggest-card"); await sleep(35000);
  await shot("conversation-running");

  for (let i = 0; i < 30; i++) { if (await page.$(".copy-btn")) break; await sleep(6000); }
  await page.evaluate(() => { const c = document.querySelector(".conversation"); if (c) c.scrollTo({ top: 0 }); });
  await sleep(1200);
  await shot("conversation-done-top");
  await page.evaluate(() => { const c = document.querySelector(".conversation"); if (c) c.scrollTo({ top: c.scrollHeight }); });
  await sleep(1200);
  await shot("conversation-done-bottom");

  await page.click("#artifacts-btn"); await sleep(1500);
  await shot("artifacts-drawer");
  const rows = await page.$$(".art-row");
  if (rows.length) { await rows[0].click(); await sleep(2500); await shot("artifact-viewer"); await page.click("#viewer-close").catch(() => {}); await sleep(500); }
  await page.click("#drawer-close").catch(() => {}); await sleep(500);

  await page.click("#theme-toggle"); await sleep(1200);
  await shot("conversation-light");
  await page.click('.agent-card[data-id="orchestrator"]'); await sleep(1200);
  await shot("agent-intro-light");
  await page.click("#settings-btn"); await sleep(700);
  await shot("settings-light");
  await page.click("#set-cancel"); await sleep(300);

  await ctx.close(); await browser.close();
  console.log("DONE", OUT);
})().catch((e) => { console.error("FAILED", e); process.exit(1); });
