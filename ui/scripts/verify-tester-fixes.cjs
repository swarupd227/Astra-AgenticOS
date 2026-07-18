const { chromium } = require("playwright");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shotDir = path.join(__dirname, "..", "review-shots");

(async () => {
  const b = await chromium.launch();

  // --- Desktop checks ---
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await sleep(2000);

  const desktop = await p.evaluate(() => ({
    sendHasIcon: !!document.querySelector("#send svg"),
    brandCursor: getComputedStyle(document.getElementById("brand")).cursor,
    navToggleVisible: getComputedStyle(document.getElementById("nav-toggle")).display !== "none",
    modelHasDatalist: document.getElementById("set-model") ? undefined : null,
    datalistOptions: [...document.querySelectorAll("#model-list option")].map(o => o.value),
  }));
  console.log("DESKTOP:", JSON.stringify(desktop));

  // active-agent header appears after selecting an agent
  await p.click('.agent-card[data-id="impact-analysis"]');
  await sleep(1200);
  const hdr = await p.evaluate(() => ({
    topbarShown: !document.getElementById("chat-topbar").hidden,
    agentName: document.getElementById("ct-name").textContent,
  }));
  console.log("CHAT-HEADER:", JSON.stringify(hdr));

  // logo returns home
  await p.click("#brand");
  await sleep(600);
  const home = await p.evaluate(() => ({
    topbarHidden: document.getElementById("chat-topbar").hidden,
    welcomeShown: !!document.querySelector(".welcome, .onboard"),
  }));
  console.log("LOGO-HOME:", JSON.stringify(home));
  await ctx.close();

  // --- Mobile / narrow viewport (UI-02) ---
  const mctx = await b.newContext({ viewport: { width: 600, height: 850 } });
  const mp = await mctx.newPage();
  await mp.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await sleep(1500);
  const beforeOpen = await mp.evaluate(() => ({
    hamburgerVisible: getComputedStyle(document.getElementById("nav-toggle")).display !== "none",
    sidebarOnscreen: document.querySelector(".sidebar").getBoundingClientRect().left >= 0,
  }));
  await mp.click("#nav-toggle");
  await sleep(500);
  const afterOpen = await mp.evaluate(() => ({
    navOpen: document.body.classList.contains("nav-open"),
    sidebarOnscreen: document.querySelector(".sidebar").getBoundingClientRect().left >= 0,
  }));
  console.log("MOBILE before toggle:", JSON.stringify(beforeOpen));
  console.log("MOBILE after toggle :", JSON.stringify(afterOpen));
  await mp.screenshot({ path: path.join(shotDir, "95-mobile-nav-open.png") });
  await b.close();
})();
