const { chromium } = require("playwright");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await sleep(2000);

  // P2-2: project menu — unavailable projects greyed + names unique
  await p.click("#project-btn");
  await sleep(800);
  const menu = await p.evaluate(() =>
    [...document.querySelectorAll(".pm-item")].map((el) => ({
      name: el.querySelector(".pm-name")?.textContent,
      sub: el.querySelector(".pm-sub")?.textContent,
      unavailable: el.classList.contains("pm-unavailable"),
      opacity: getComputedStyle(el).opacity,
    })));
  console.log("PROJECT MENU:", JSON.stringify(menu, null, 2));
  await p.screenshot({ path: path.join(__dirname, "..", "review-shots", "97-project-menu-fixed.png") });
  await p.click("#project-btn");
  await sleep(400);

  // P2-1: simulate "no key" and check the pill routes to Settings
  await p.route("**/api/health", async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    j.hasApiKey = false;
    await route.fulfill({ response: r, body: JSON.stringify(j) });
  });
  await p.reload({ waitUntil: "networkidle" });
  await sleep(2500);
  const pill = await p.evaluate(() => {
    const el = document.getElementById("status");
    return { text: el.innerText.trim(), clickable: el.classList.contains("clickable"), cursor: getComputedStyle(el).cursor };
  });
  console.log("NO-KEY PILL:", JSON.stringify(pill));
  await p.click("#status");
  await sleep(700);
  const opened = await p.evaluate(() => !document.getElementById("settings-backdrop").hidden);
  console.log("clicking pill opened Settings:", opened);
  await p.screenshot({ path: path.join(__dirname, "..", "review-shots", "96-nokey-settings.png") });
  await b.close();
})();
