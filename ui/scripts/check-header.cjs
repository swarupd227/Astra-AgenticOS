const { chromium } = require("playwright");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = process.env.BASE || "http://localhost:5199";
const dir = path.join(__dirname, "..", "review-shots");

(async () => {
  const b = await chromium.launch();
  for (const w of [1440, 900, 760, 600, 420]) {
    const p = await (await b.newContext({ viewport: { width: w, height: 850 } })).newPage();
    await p.goto(BASE, { waitUntil: "networkidle" });
    await sleep(1800);
    const r = await p.evaluate(() => {
      const h = document.querySelector(".app-header");
      const hb = h.getBoundingClientRect();
      const kids = [...h.querySelectorAll(".brand, .header-right > *")].map((e) => e.getBoundingClientRect());
      const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
      return {
        headerH: Math.round(hb.height),
        // tallest child — if anything wrapped it exceeds ~38px
        tallestChild: Math.round(Math.max(...kids.map((k) => k.height))),
        rightEdgeOk: Math.max(...kids.map((k) => k.right)) <= Math.round(hb.right) + 1,
        hOverflow: overflow,
      };
    });
    console.log(`w=${String(w).padStart(4)}  headerH=${r.headerH}  tallestChild=${r.tallestChild}  fitsWidth=${r.rightEdgeOk}  pageHScroll=${r.hOverflow}`);
    if (w === 600 || w === 420) await p.screenshot({ path: path.join(dir, `96-header-${w}.png`), clip: { x: 0, y: 0, width: w, height: 70 } });
  }
  await b.close();
})();
