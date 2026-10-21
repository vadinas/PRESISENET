import { runSimulation } from "../sim/simulator.mjs";
import { normalizeTarget } from "../sim/target.mjs";

function tokenFromRequest(req) {
  const url = new URL(req.url, "http://localhost");
  const h = req.headers || {};
  const values = [
    h["x-presistent-token"],
    h["authorization"] && h["authorization"].indexOf("Bearer ") === 0 ? h["authorization"].slice(7).trim() : "",
    url.searchParams.get("token"),
  ].filter(Boolean);
  return values[0] || "";
}

function isAuthorized(req) {
  const simToken = process.env.SIM_TOKEN || "";
  const cronSecret = process.env.CRON_SECRET || "";
  const auth = (req.headers["authorization"] || "").trim();
  if (auth && auth.indexOf("Bearer ") === 0 && cronSecret && auth.slice(7).trim() === cronSecret) return true;
  if (!simToken && !cronSecret) return true;
  const t = tokenFromRequest(req);
  if (simToken && t === simToken) return true;
  return false;
}

export const maxDuration = 60;

export default async function handler(req, res) {
  const origin = (req.headers.origin || "").toString();
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-presistent-token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  try {
    if (!isAuthorized(req)) {
      res.status(401).json({ service: "presistent", error: "token obrigatório (SIM_TOKEN)", verdict: "unauthorized" });
      return;
    }
    const chatOnVercel = String(process.env.SIM_ENABLE_CHAT ?? "false").toLowerCase() === "true";
    const report = await runSimulation({
      target: normalizeTarget(req.query && req.query.target ? String(req.query.target) : process.env.TARGET_URL),
      chatEnabled: chatOnVercel ? "true" : "false",
      chatHours: process.env.SIM_CHAT_HOURS ?? "9,15,21",
      forceChat: String(req.query.force_chat || "") === "1" && chatOnVercel,
      pollSeconds: Math.min(35, Number(process.env.SIM_CHAT_POLL_SECONDS ?? 35)),
      assetsMax: process.env.SIM_ASSETS_MAX ?? 2,
      timeoutMs: process.env.SIM_TIMEOUT_MS ?? 12500,
      jitterMs: process.env.SIM_JITTER_MS ?? "80,500",
      stateDir: null,
      userAgent: process.env.SIM_UA,
    });
    // LOG DETALHADO PARA MONITORIZAÇÃO
    const shortSteps = report.steps.slice(0, 10).map(s => `${s.path} ${s.status} ${s.ms}ms`);
    console.log(`[SIM-VLGR] ${new Date().toISOString()} | method=${req.method} | path=${req.url} | verdict=${report.verdict} | okRate=${report.okRate} | chat=${report.chat.status} | took=${report.tookMs}ms | assets=${report.assets.length}`);
    console.log(`[SIM-VLGR] steps: [${shortSteps.join(", ")}]`);
    if (report.chat.attempted) {
      console.log(`[SIM-VLGR] chat: ${report.chat.status} • provider ${report.chat.provider || "-"} • ${report.chat.replyChars} chars • markdown ${report.chat.markdownDetected}`);
      if (report.chat.replyPreview) console.log(`[SIM-VLGR] preview: "${report.chat.replyPreview}"`);
    }
    if (report.errors.length) {
      console.log(`[SIM-VLGR] errors: ${report.errors.join("; ")}`);
    }
    res.status(200).json(report);
  } catch (err) {
    console.error(`[SIM-VLGR] ERRO handler: ${err && err.message ? err.message : err}`);
    res.status(500).json({ service: "presistent", verdict: "failed", error: err && err.message ? err.message : String(err) });
  }
}
