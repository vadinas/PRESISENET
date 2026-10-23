import { runSimulation } from "../sim/simulator.mjs";
import { normalizeTarget } from "../sim/target.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let waitUntilFn = null;
try {
  const mod = await import("@vercel/functions");
  if (typeof mod.waitUntil === "function") waitUntilFn = mod.waitUntil;
} catch { /* runtime sem waitUntil: fica o race manual */ }

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

// Despacha o filho com GARANTIA: espera pelo 200 real da invocação filha
// (nunca desiste cedo — desistir cedo congelava o filho em voo e matava a cadeia
// na profundidade 5+). Erros de rede -> retry com backoff. O waitUntil mantém a
// execução viva além da resposta, por isso o await total é seguro.
async function dispatchChild(nextUrl, token) {
  const headers = { "x-presistent-token": token, "user-agent": "presistent-chain/1.0" };
  for (let attempt = 1; attempt <= 4; attempt++) {
    let p;
    try {
      p = fetch(nextUrl, { method: "GET", headers });
      p.catch(() => {}); // rejeições tardias nunca devem partir o runtime
    } catch {
      await sleep(2000 * attempt);
      continue;
    }
    try {
      const r = await p; // ESPERA TOTAL pelo filho
      if (r && typeof r === "object") {
        if (r.ok) return true;
        if (r.status === 401 || r.status === 404) return false; // token/rota errada: sem esperança de retry
      }
    } catch { /* rede: repete */ }
    await sleep(2000 * attempt);
  }
  return false;
}

// Fluid compute no Hobby permite até 150s — necessário para aguentar a espera
// total da confirmação do filho (~80s de vida de uma geração).
export const maxDuration = 150;

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
    const delay = Math.min(45000, Math.max(5000, Number(process.env.SIM_CHAIN_DELAY_MS || 35000)));
    const roundsEvery = Math.max(1, Number(process.env.SIM_CHAIN_ROUNDS_EVERY || 2));
    const doRound = depth % roundsEvery === 0;
    const nextDepth = depth + 1;

    if (depth >= maxDepth) {
      console.log(`[SIM-CHAIN] depth=${depth} >= maxDepth (${maxDepth}) — parado; novo semente vem dos crons ou da ressurreição.`);
      res.status(200).json({ service: "presistent-chain", ok: true, depth, stopped: "maxDepth" });
      return;
    }

    // 1) timer da cadência: TODAS as gerações dormem
    await sleep(delay);

    // 2) DESPACHA o filho SEMPRE ANTES da ronda (se a ronda for lenta/render acordando,
    //    60s do maxDuration nunca apanha o despacho desfeito)
    const nextUrl = `${selfUrl(req)}/api/chain?depth=${nextDepth}&token=${encodeURIComponent(token)}`;
    const childPromise = dispatchChild(nextUrl, token);

    // waitUntil = a runtime fica VIVA mesmo após a resposta, até o filho estar CONFIRMADO.
    // Isto elimina a perda de transmissão (causa nº1 de cadeias mortas).
    if (waitUntilFn) waitUntilFn(childPromise.catch(() => {}));
    else await Promise.race([childPromise, sleep(9000)]);

    // 3) ronda na Render (só nas gerações de ronda)
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

    // 3) publica o estado na app AKIRA (bot_ui) para o chip "Anti-sleep"
    if (report) {
      try {
        const statsTarget = normalizeTarget(process.env.TARGET_URL || "https://akira-ia.onrender.com");
        void fetch(`${statsTarget}/api/keepalive-stats`, {
          method: "POST",
          headers: { "x-presistent-token": token, "content-type": "application/json" },
          body: JSON.stringify({
            depth,
            verdict: report.verdict,
            okRate: report.okRate ?? null,
            tookMs: report.tookMs || 0,
          }),
          signal: AbortSignal.timeout(6000),
        }).catch(() => {});
      } catch { /* o relatório nunca bloqueia a cadeia */ }
    }

    console.log(
      `[SIM-CHAIN] depth=${depth} round=${doRound} verdict=${report ? report.verdict : "skip"} okRate=${report ? report.okRate : "-"}`,
    );

    res.status(200).json({
      service: "presistent-chain",
      ok: true,
      depth,
      next: nextDepth,
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