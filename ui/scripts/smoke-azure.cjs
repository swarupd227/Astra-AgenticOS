const { chromium } = require("playwright");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = process.env.BASE || "https://astra-agenticos-22676.azurewebsites.net";
const dir = path.join(__dirname, "..", "review-shots");

(async () => {
  const b = await chromium.launch();

  // Desktop
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = [];
  p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  p.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message));
  await p.goto(BASE, { waitUntil: "networkidle" });
  await sleep(3000);

  const checks = await p.evaluate(() => {
    const cs = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : "MISSING"; };
    return {
      agentNameColor: cs(".agent-name", "color"),          // must NOT be rgb(0,0,0) in dark
      agentNameDisplay: cs(".agent-name", "display"),       // must be block
      sendHasIcon: !!document.querySelector("#send svg"),
      brandCursor: cs("#brand", "cursor"),
      datalistOptions: [...document.querySelectorAll("#model-list option")].length,
      agentCount: document.querySelectorAll(".agent-card").length,
      projectName: document.getElementById("project-name")?.textContent,
      statusText: document.getElementById("status")?.innerText.trim(),
    };
  });
  console.log("DESKTOP:", JSON.stringify(checks, null, 1));
  await p.screenshot({ path: path.join(dir, "90-azure-desktop.png") });

  // Mobile (UI-02)
  const mp = await (await b.newContext({ viewport: { width: 600, height: 850 } })).newPage();
  await mp.goto(BASE, { waitUntil: "networkidle" });
  await sleep(2500);
  const before = await mp.evaluate(() => document.querySelector(".sidebar").getBoundingClientRect().left >= 0);
  await mp.click("#nav-toggle");
  await sleep(600);
  const after = await mp.evaluate(() => document.querySelector(".sidebar").getBoundingClientRect().left >= 0);
  console.log("MOBILE sidebar onscreen before/after toggle:", before, "/", after);
  await mp.screenshot({ path: path.join(dir, "91-azure-mobile.png") });

  console.log("CONSOLE ERRORS:", errs.length ? errs.slice(0, 5) : "none");
  await b.close();
})();
