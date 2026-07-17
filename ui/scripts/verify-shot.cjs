const { chromium } = require("playwright");
const path = require("path");
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await p.waitForTimeout(2000);
  const out = path.join(__dirname, "..", "review-shots", "99-after-fix-dark.png");
  await p.screenshot({ path: out });
  console.log("shot", out);
  await b.close();
})();
