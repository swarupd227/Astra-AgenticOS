const { chromium } = require("playwright");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await sleep(2000);

  // pick an agent and ask something cheap
  await p.click('.agent-card[data-id="spec-validator"]');
  await sleep(1200);
  await p.fill("#input", "Reply with exactly: PERSISTENCE-CHECK-OK. Do not use tools.");
  await p.press("#input", "Enter");

  for (let i = 0; i < 30; i++) { if (await p.$(".copy-btn")) break; await sleep(3000); }
  const before = await p.evaluate(() => document.querySelectorAll(".msg").length);
  console.log("messages before reload:", before);

  // THE TEST: reload the page
  await p.reload({ waitUntil: "networkidle" });
  await sleep(2500);
  await p.click('.agent-card[data-id="spec-validator"]');
  await sleep(3000);

  const after = await p.evaluate(() => ({
    msgs: document.querySelectorAll(".msg").length,
    restoredNote: !!document.querySelector(".restored-note"),
    text: document.body.innerText.includes("PERSISTENCE-CHECK-OK"),
  }));
  console.log("AFTER RELOAD -> messages:", after.msgs, "| restored banner:", after.restoredNote, "| answer present:", after.text);
  await p.screenshot({ path: path.join(__dirname, "..", "review-shots", "98-persistence-after-reload.png") });
  await b.close();
})();
