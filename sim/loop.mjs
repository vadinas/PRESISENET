#!/usr/bin/env node
import { runSimulation } from "./simulator.mjs";
import { runBrowserSimulation } from "./browser.mjs";
import { normalizeTarget } from "./target.mjs";

const targetUrl = normalizeTarget(process.env.TARGET_URL || "https://akira-ia.onrender.com");
const intervalSec = Number(process.env.SIM_INTERVAL_SECONDS || 180);
const tolerance = intervalSec * 0.2;
const browserMode = String(process.env.SIM_BROWSER || "0") === "1";
const browserEvery = Number(process.env.SIM_BROWSER_EVERY || 4);
let counter = 0;

const runHttp = async () => {
  const t0 = Date.now();
  const r = await runSimulation({
    target: targetUrl,
    chatEnabled: String(process.env.SIM_ENABLE_CHAT ?? "true"),
    chatHours: process.env.SIM_CHAT_HOURS ?? "9,15,21",
    pollSeconds: process.env.SIM_CHAT_POLL_SECONDS,
    assetsMax: process.env.SIM_ASSETS_MAX,
    timeoutMs: process.env.SIM_TIMEOUT_MS,
    jitterMs: process.env.SIM_JITTER_MS,
    stateDir: process.env.SIM_STATE_DIR ?? "sim/state",
    userAgent: process.env.SIM_UA,
  });
  console.log(`[${new Date().toISOString()}] [http] ronda ${r.verdict} okRate=${r.okRate} took=${Date.now() - t0}ms chat=${r.chat.status}${r.chat.attempted && r.chat.status === "ok" ? ` md=${r.chat.markdownDetected}` : ""}`);
  return r;
};

const runBrowserRound = async () => {
  const t0 = Date.now();
  const r = await runBrowserSimulation({ forceChat: !process.argv.includes("--no-chat") });
  console.log(`[${new Date().toISOString()}] [chromium] ronda ${r.browserOk ? "ok" : "falhou"} pages=${r.steps.length} consoleErrors=${r.consoleErrors.length} chat=${r.chat ? r.chat.status : "n/a"} took=${Date.now() - t0}ms`);
  return r;
};

const round = async () => {
  try {
    counter++;
    if (browserMode && counter % browserEvery === 0) {
      console.log(`[${new Date().toISOString()}] ronda ${counter}: modo CHROMIUM REAL (simula navegação humana completa)`);
      await runBrowserRound();
    }
    await runHttp();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ronda falhada: ${err && err.message ? err.message : err}`);
  }
};

const schedule = () => {
  const jitter = (intervalSec * 0.2) * (Math.random() - 0.5) * 2;
  const wait = Math.max(10, intervalSec * 1000 + jitter * 1000);
  round().then(() => setTimeout(schedule, wait));
};

console.log(`presistent loop: intervalo ~${intervalSec}s | alvo ${targetUrl} | chromium=${browserMode ? "ligado (1/" + browserEvery + " rondas)" : "desligado"}`);
schedule();