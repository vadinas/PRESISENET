import { normalizeTarget } from "../sim/target.mjs";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", (req.headers.origin || "*").toString());
  res.setHeader("Cache-Control", "no-store");

  const report = {
    service: "presistent",
    ok: true,
    time: new Date().toISOString(),
    target: normalizeTarget(process.env.TARGET_URL || ""),
    auth: (process.env.SIM_TOKEN || process.env.CRON_SECRET) ? "requerida" : "aberta",
    chat: String(process.env.SIM_ENABLE_CHAT ?? "false"),
  };

  console.log(`[SIM-VLGR] STATUS_REQUEST | target=${report.target} | auth=${report.auth} | chat=${report.chat}`);
  res.status(200).json(report);
}