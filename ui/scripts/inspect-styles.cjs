const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);

  const probe = async (label) => {
    const r = await p.evaluate(() => {
      const g = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : "MISSING"; };
      const disp = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display : "MISSING"; };
      return {
        theme: document.documentElement.getAttribute("data-theme"),
        sidebarBg: g(".sidebar", "backgroundColor"),
        bodyColor: getComputedStyle(document.body).color,
        agentCardColor: g(".agent-card", "color"),
        agentNameColor: g(".agent-name", "color"),
        agentDescColor: g(".agent-desc", "color"),
        welcomeCardColor: g(".welcome-card", "color"),
        wcNameColor: g(".wc-name", "color"),
        agentMetaDisplay: disp(".agent-meta"),
        agentNameDisplay: disp(".agent-name"),
      };
    });
    console.log(label, JSON.stringify(r, null, 2));
  };

  await probe("DARK:");
  await p.click("#theme-toggle"); await p.waitForTimeout(800);
  await probe("LIGHT:");
  await b.close();
})();
