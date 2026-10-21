import { runSimulation } from "../sim/simulator.mjs";
import { normalizeTarget } from "../sim/target.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return !!simToken && t === simToken;
}

function selfUrl(req) {
  const h = req.headers || {};
  const host = h["x-forwarded-host"] || h.host || "";
  const proto = h["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

async function fireChild(nextUrl, token) {
  const headers = { "x-presistent-token": token, "user-agent": "presistent-chain/1.0" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const p = fetch(nextUrl, { method: "GET", headers });
      await Promise.race([p, sleep(3000)]);
      return true;
    } catch {
      await sleep(500 * attempt);
    }
  }
  return false;
}

export const maxDuration = 60;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", (req.headers.origin || "*").toString());
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  try {
    if (!isAuthorized(req)) {
      res.status(401).json({ service: "presistent-chain", error: "token obrigatório (SIM_TOKEN)", ok: false });
      return;
    }

    const token = tokenFromRequest(req) || process.env.CRON_SECRET || process.env.SIM_TOKEN || "";
    const depth = Number(req.query.depth || 0);
    const maxDepth = Number(process.env.SIM_CHAIN_DEPTH_CAP || 20000);
    const delay = Math.min(45000, Math.max(5000, Number(process.env.SIM_CHAIN_DELAY_MS || 40000)));
    const roundsEvery = Math.max(1, Number(process.env.SIM_CHAIN_ROUNDS_EVERY || 2));
    const doRound = depth % roundsEvery === 0;
    const nextDepth = depth + 1;

    if (depth >= maxDepth) {
      console.log(`[SIM-CHAIN] depth=${depth} >= maxDepth (${maxDepth}) — corrente parada; aguardar novo semente diário.`);
      res.status(200).json({ service: "presistent-chain", ok: true, depth, stopped: "maxDepth" });
      return;
    }

    // 1) Dorme o intervalo (o "timer" da cadência vive aqui — TODAS as gerações dormem,
    //    para que a distância entre rondas seja ~2×o delay e não ~1×delay)
    await sleep(delay);

    // 2) Despacha a próxima geração ANTES da ronda — ronda lenta nunca mata a corrente
    const nextUrl = `${selfUrl(req)}/api/chain?depth=${nextDepth}&token=${encodeURIComponent(token)}`;
    const dispatched = await fireChild(nextUrl, token);

    // 3) Só depois faz a ronda (fala com a Render) — qualquer lentidão aqui é irrelevante para a cadeia
    let report = null;
    if (doRound) {
      try {
        report = await runSimulation({
          target: normalizeTarget(process.env.TARGET_URL || "https://akira-ia.onrender.com"),
          chatEnabled: "false",
          assetsMax: process.env.SIM_ASSETS_MAX ?? 2,
          timeoutMs: process.env.SIM_TIMEOUT_MS ?? 12500,
          jitterMs: process.env.SIM_JITTER_MS ?? "80,500",
          stateDir: null,
          userAgent: process.env.SIM_UA,
        });
      } catch (e) {
        report = { verdict: "erro-ronda", ok: false, error: (e && e.message) || String(e) };
      }
    }

    console.log(
      `[SIM-CHAIN] depth=${depth} dispatched=${dispatched ? "sim" : "NAO"} round=${doRound} verdict=${report ? report.verdict : "skip"} okRate=${report ? report.okRate : "-"}`,
    );

    res.status(200).json({
      service: "presistent-chain",
      ok: true,
      depth,
      next: nextDepth,
      dispatched,
      round: doRound,
      verdict: report ? report.verdict : "skipped",
      okRate: report ? report.okRate : null,
      tookMs: report ? report.tookMs || 0 : 0,
    });
  } catch (err) {
    console.error(`[SIM-CHAIN] erro: ${err && err.message ? err.message : err}`);
    res.status(500).json({ service: "presistent-chain", ok: false, error: err && err.message ? err.message : String(err) });
  }
}