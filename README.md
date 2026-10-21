# PRESITEN

> **Repositório: PRESITEN — Simulador de browser para manter a AKIRA UI (Render FREE) sem adormecer.**

`Node >=20 · Zero deps · Vercel/Actions/Docker`

O PRESITEN — do nome interno "presistent" (presistente, simulador de browser) — tem **dois motores de navegação**:

- **Core HTTP** (Node >= 20, `fetch` nativo, zero dependências em runtime) — usado no GitHub Actions, na Vercel e em qualquer runner: navega de verdade na app **AKIRA UI** (Next.js, Docker, plano FREE) em <https://akira-ia.onrender.com/>: várias rotas de página, chamadas de boot de API, assets de bundle, sessão com cookie jar persistente e, opcionalmente, um round-trip **real** de chat.
- **Modo browser real** (Playwright + Chromium/Edge) — para auditorias visuais: renderiza a app de verdade, clica nas ligações de navegação interno, faz scroll humano e valida consola. Vê a §3.1.

Objetivo duplo: gerar tráfego realista para que o plano FREE da Render **nunca adormeça** e validar que o serviço está **realmente utilizável**.

---

## 1. Porquê

No plano **FREE**, a Render adormece o serviço após ~**15 minutos** sem tráfego; o próximo visitante paga o arranque a frio (cold start de dezenas de segundos). Um *ping* periódico (`GET /` a cada X minutos) evita o adormecimento, mas **não é suficiente** para o dono:

- não exercita a aplicação — nenhum asset, nenhuma API de boot, nenhuma sessão;
- não distingue "processo vivo" de "serviço realmente utilizável";
- não valida o chat, que é o coração da AKIRA.

O PRESITEN **navega como um browser de verdade** e valida tudo:

| O que | Como |
| ----- | ---- |
| Páginas | `GET /` + 1 página aleatória por ronda (`/login`, `/plans`, `/tasks`) |
| Assets | `/_next/static/**` extraídos do HTML de `/` (`SIM_ASSETS_MAX` por ronda) |
| APIs de boot | `/api/auth/session`, `/api/billing`, `/api/health`, `/api/health/ready` |
| Sessão | cookie jar persistente (`sim/state/session.json`) — retoma a sessão em vez de criar um utilizador novo na DB a cada ronda |
| Chat (opcional) | `POST /api/chat` + polling `GET /api/chat?jobId=` — valida a resposta da IA, limitado por janelas horárias para não queimar quotas de convidado |

## 2. Arquitectura — 3 modos de agendamento

```
   (a) GitHub Actions (PRINCIPAL)
       cron */10 (UTC) + workflow_dispatch
       corre "node sim/run.mjs" direto no runner (zero install)
       estado da sessão: sim/state/ via actions/cache
       opcional: com secrets VERCEL_SIM_URL/VERCEL_SIM_TOKEN dispara (b)
           |
           |  HTTPS — navega como um browser real
           |        (HTML, assets, APIs de boot, sessão, chat)
           v
       AKIRA UI (Render FREE) -- https://akira-ia.onrender.com
           ^                        adormece ~15 min sem tráfego
           |  HTTPS
       (b) Vercel Functions (fallback + disparo HTTP)
           api/simulate.mjs  --  cron diário (fallback) + HTTP com token
           api/status.mjs    +  painel manual public/index.html em "/"

   (c) Docker / loop local
        docker/Dockerfile (CMD via docker-entry.sh) + docker-compose.yml
        rondas contínuas com intervalo SIM_INTERVAL_SECONDS (default 180 s)
        estado: sim/state/session.json (volume)
```

| Modo | Onde corre | Agendamento | Estado da sessão | Papel |
| ---- | ---------- | ----------- | ---------------- | ----- |
| **(a) GitHub Actions** — recomendado | runner do GitHub (workflow `.github/workflows/keep-alive.yml`), node direto no runner |         cron **`*/2`** min + `workflow_dispatch` | `sim/state/` via `actions/cache` | motor principal do keep-alive; dispara a cópia Vercel (opcional) |
| **(b) Vercel Functions** | `api/simulate.mjs` + `api/status.mjs`, painel `public/index.html` em `/` | cron **diário** (limite do Hobby) + HTTP com token | serverless (sem disco persistente) | fallback diário; disparos a quente |
| **(c) Docker / loop local** | container (`Dockerfile`, `docker-compose.yml`) ou máquina própria (`sim/loop.mjs`) | interno: `SIM_INTERVAL_SECONDS` (default 180 s) | `sim/state/session.json` em volume | ronda contínua em infra própria |

Notas:

- O keep-alive corre `node sim/run.mjs` **diretamente no runner** — nada para instalar (zero deps), sem imagem Docker no caminho do cron.
- Com os secrets `VERCEL_SIM_URL` + `VERCEL_SIM_TOKEN` definidos, cada ronda do Actions também **dispara a mesma simulação na instância Vercel** (`POST` com header de token). Sem os secrets, o passo é simplesmente omitido.
- O cron da Vercel corre apenas **1x/dia** no Hobby — serve exclusivamente de *fallback*; o agendamento real é o cron do Actions (*/10), que tem folga face aos ~15 min de silêncio que a Render tolera.

## 3. Rodada de simulação — steps

Cada ronda (`node sim/run.mjs` ou uma chamada a `/api/simulate`) executa:

| # | Step | Detalhe |
| - | ---- | ------- |
| 1 | `GET /` | HTML inicial; extrai as rotas reais e a lista de assets `/_next/static/**` |
| 2 | Assets `/_next/static/**` | até `SIM_ASSETS_MAX` (default **3**) por ronda, variando de ronda para ronda |
| 3 | `GET /api/auth/session` | boot da sessão do convidado |
| 4 | `GET /api/billing` | estado do plano/billing |
| 5 | `GET /api/health` | liveness |
| 6 | `GET /api/health/ready` | **readiness real** (confirma a DB ligada) |
| 7 | 1 página aleatória | uma de: `/login`, `/plans`, `/tasks` |
| 8 | `robots.txt` + `sitemap.xml` | rotas não críticas, típicas de navegação real |
| 9 | Chat (opcional) | profile + `POST /api/chat` + polling do `jobId` — secção 4 |

### 3.1 Modo browser real (Playwright + Chromium)

Para auditoria visual ("um humano abriu a página e navegou de verdade"), `node sim/browser.mjs` lança um **Chromium de verdade** (Edge/Chrome instalado na máquina, `headless-shell` da imagem Docker ou `@sparticuz/chromium` em serverless) e:

1. `goto /` com `domcontentloaded` + espera `networkidle` (página 100% hidratada);
2. **clica nas ligações reais da navegação** (`/plans`, `/tasks`, `/login`) — quando existem no DOM — em vez de navegar por URL;
3. faz **scroll humano** em cada página (passos de 300-700 px);
4. opcionalmente envia o **chat real** via `page.request` (mesmos cookies do browser): `POST /api/auth/profile` + `POST /api/chat` + polling do `jobId`;
5. captura o título da página, erros de consola e (com `SIM_SCREENSHOT=1`) um screenshot final em `sim/state/last-browser.png`.

```sh
node sim/browser.mjs            # com chat
node sim/browser.mjs --no-chat  # só navegação visual
node browserSimulator.js        # name de compatibilidade (mesma coisa)
```

Comportamento transversal a todos os pedidos:

- **User-Agent**: por ronda é escolhido aleatoriamente de um pool de Chrome modernos; `SIM_UA` fixa um estático.
- **Jitter**: pausa aleatória entre pedidos, em `SIM_JITTER_MS` (default `120,900` ms) — imita navegação humana.
- **Timeout**: `SIM_TIMEOUT_MS` por pedido (default 15000).
- **Sessão persistente**: cookie jar em `SIM_STATE_DIR` (`sim/state/session.json`, criada em runtime) — retoma a sessão existente em vez de criar utilizador novo na DB a cada ronda. Se a escrita falhar (ex.: disco read-only na Vercel), a ronda **continua sem estado** — nunca falha por causa do disco.

## 4. Chat real segurado

Com `SIM_ENABLE_CHAT=true` e a hora UTC dentro de `SIM_CHAT_HOURS`, a ronda executa um round-trip real:

1. **`POST /api/auth/profile`** — atualiza o perfil do **próprio convidado** (única "mutation" da simulação; nada de dados de terceiros, nada perigoso).
2. **`POST /api/chat`** — mensagem real; resposta esperada **202** com `jobId`.
3. **Polling `GET /api/chat?jobId=<jobId>`** — **202** = ainda a processar (segue a poll); **200** = resposta final da IA; **503** = indisponível/fila cheia (termina e marca `degraded`).
4. Espera máxima total: `SIM_CHAT_POLL_SECONDS` (default **45** s), respeitando o jitter entre polls.

Controlo de quotas e janelas:

| Controlo | Valor | Efeito |
| -------- | ----- | ------ |
| `SIM_CHAT_HOURS` | `9,15,21` (UTC) | chat só nestas horas: **3 chats/dia**, com folga para o limite de **10 msgs/dia por convidado** |
| `SIM_CHAT_HOURS` | `*` | sempre (cuidado: pode esgotar a quota) |
| `SIM_FORCE_CHAT` | `1` | força o chat **fora** da janela — apenas para testes (`node sim/run.mjs --chat` faz o mesmo) |
| (cópia Vercel) | `SIM_ENABLE_CHAT=false` | recomendação: não gastar quota num ambiente serverless |

Validação da resposta: o simulador guarda `replyPreview`, `replyChars`, o provider e corre a **heurística de markdown** (`chat.markdownDetected`) para auditar a exigência "responder sem markdown" (secção 11).

## 5. API do PRESITEN

| Rota | Métodos | Descrição |
| ---- | ------- | --------- |
| `/api/simulate` | `GET` ou `POST` | corre **uma ronda completa** de simulação e devolve o relatório JSON (mesma shape de `node sim/run.mjs`) |
| `/api/status` | `GET` | estado rápido da instância (config ativa, último resultado quando disponível) |

- **Auth opcional**: se `SIM_TOKEN` estiver definido, `/api/simulate` exige o token no header `x-presistent-token: <token>`, em `Authorization: Bearer <token>`, ou em `?token=<token>`. Sem `SIM_TOKEN`, o endpoint fica aberto.
- **Veredicto** (`verdict`): `warm_ok` (acordado e tudo ok) / `degraded` (falha parcial — ex.: 503 do chat, asset em falta) / `failed` (crítico em falha).
- **Painel manual** (`public/index.html`, servido na raiz `/` da instância Vercel): botão **"Correr simulação"** chama `/api/simulate` e apresenta o relatório formatado (steps, chat, `okRate`, `verdict`).

## 6. Deploy na Vercel

Envs recomendadas para a cópia Vercel: `TARGET_URL`, **`SIM_ENABLE_CHAT=false`**, `SIM_TOKEN` e `CRON_SECRET` (opcional, para autenticar o cron diário).

**(a) Via CLI:**

```sh
npx vercel login
npx vercel link                # projeto: presiten (framework: Other)
vercel env add TARGET_URL      # https://akira-ia.onrender.com
vercel env add SIM_ENABLE_CHAT # false
vercel env add SIM_TOKEN       # token forte (ativa auth em /api/simulate)
vercel env add CRON_SECRET     # opcional — auth do cron diário
npx vercel --prod
```

**(b) Via GitHub import** (dashboard): *Add New → Project → Import* o repo `PRESITEN`, definir as mesmas envs em *Settings → Environment Variables* e fazer *Deploy*.

Pós-deploy:

- `vercel.json` já contém o cron **diário** para `/api/simulate` e `maxDuration: 60` na function (60 s por ronda; ajustável no ficheiro se precisares de mais).
- **Nota**: no Hobby da Vercel o cron corre apenas **1x/dia** — fica como fallback; o agendamento real é o **GitHub Actions** (*/10, secção 7).
- Guarda o domínio (ex.: `https://presiten.vercel.app`) — é o valor do secret `VERCEL_SIM_URL` no Actions.
- Painel disponível na raiz `/`; disparo a quente em `POST /api/simulate` (com token, se `SIM_TOKEN` definido).

## 7. Deploy via GitHub Actions (principal)

Workflow de agendamento: **`.github/workflows/keep-alive.yml`**

- **`schedule: "*/10 * * * *"`** (UTC) + **`workflow_dispatch`** (roda manualmente na tab Actions, "Run workflow").
- **Zero instalação**: corre `node sim/run.mjs` diretamente no runner (Node 20); sem `npm install`, sem imagem.
- **Estado da sessão via `actions/cache`**: restaura `sim/state/` no início e grava de volta no fim — o cookie jar sobrevive entre runs; num cache miss (evicção ~7 dias) a ronda cria sessão nova sem drama.
- **Disparo opcional à cópia Vercel**: com os secrets `VERCEL_SIM_URL` + `VERCEL_SIM_TOKEN` definidos, a ronda do Actions faz também `POST $VERCEL_SIM_URL/api/simulate` com header `x-presistent-token`. Sem os secrets, o passo é omitido.

Secrets (Settings → Secrets and variables → Actions → Actions):

| Secret | Obrigatório | Exemplo |
| ------ | ----------- | ------- |
| `VERCEL_SIM_URL` | não | `https://presiten.vercel.app` |
| `VERCEL_SIM_TOKEN` | não | igual ao `SIM_TOKEN` definido na Vercel |

Build da imagem: `.github/workflows/docker-build.yml` — build da imagem Docker por `workflow_dispatch` (manual) ou por `paths` (push que altere `Dockerfile`/`sim/`). Não faz deploy: não intermedeia o keep-alive (o cron corre node direto no runner).

Nota de fiabilidade: crons do GitHub Actions podem atrasar alguns minutos em picos de uso; como a Render tolera ~15 min de silêncio e a ronda corre a cada 10, há folga — e o cron diário da Vercel cobre uma eventual indisponibilidade do Actions.

## 8. Deploy via Docker

```sh
docker build -f docker/Dockerfile -t presiten .

docker run -d --name presiten --restart unless-stopped \
  -e TARGET_URL="https://akira-ia.onrender.com" \
  -e SIM_ENABLE_CHAT=true \
  -e SIM_INTERVAL_SECONDS=180 \
  -e SIM_STATE_DIR=sim/state \
  -v presiten-state:/app/sim/state \
  presiten
```

Ou com o `docker-compose.yml` incluído (já monta `sim/state` como volume):

```sh
docker compose up -d
```

- `docker/Dockerfile`: base `mcr.microsoft.com/playwright:v1.47.0-focal` (browsers Chromium pré-instalados), **`CMD` = `docker-entry.sh`** — por omissão corrido o core HTTP (`node sim/run.mjs --json`); com `SIM_BROWSER=1` corrido o **modo Chromium real** (`node sim/browser.mjs`) aproveitando os browsers da imagem.

> **Nota Vercel:** o Dockerfile vive em `docker/` (e não na raiz) para a Vercel **não** detetar o projeto como "Container Deploy" (que devolveria `500 could not connect to $PORT`). Na Vercel a entrega é `public/` + `api/*.mjs` (configurado no `vercel.json` como `framework: null, outputDirectory: public`).
- Modo loop: dorme `SIM_INTERVAL_SECONDS` (default **180** s) entre rondas; cada ronda emite o relatório completo no stdout (visível em `docker logs -f presiten`).
- Persistir `/app/sim/state` num volume mantém a sessão/cookies entre restarts e evita criar um utilizador novo na DB a cada boot do container.

## 9. Executar localmente

Scripts do `package.json`: `sim` = `node sim/run.mjs` / `sim:chat` = força o chat / `loop` = `node sim/loop.mjs`.

```sh
# ronda única (navegação completa + relatório JSON no stdout)
node sim/run.mjs
npm run sim

# ronda única com chat forçado
node sim/run.mjs --chat
npm run sim:chat

# forçar o chat fora da janela de horas (env)
SIM_FORCE_CHAT=1 node sim/run.mjs

# modo loop contínuo (intervalo SIM_INTERVAL_SECONDS, default 180 s)
npm run loop

# modo Chromium real (vee §3.1)
node sim/browser.mjs
node sim/browser.mjs --no-chat
SIM_SCREENSHOT=1 node sim/browser.mjs
```

No Windows PowerShell: `$env:SIM_FORCE_CHAT = "1"; node sim/run.mjs`.

Estado local: `sim/state/session.json` é criada em runtime logo na primeira ronda e reutilizada nas seguintes.

## 10. Relatório JSON

Shape real (valores exemplificativos):

```json
{
  "service": "presistent",
  "target": "https://akira-ia.onrender.com",
  "startedAt": "2026-10-20T09:15:02.318Z",
  "tookMs": 6412,
  "profile": {
    "userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  },
  "coldStart": false,
  "steps": [
    { "path": "/", "status": 200, "ms": 812, "ok": true },
    { "path": "/_next/static/chunks/main-app-4b2f1.js", "status": 200, "ms": 143, "ok": true },
    { "path": "/api/auth/session", "status": 200, "ms": 96, "ok": true },
    { "path": "/api/billing", "status": 200, "ms": 88, "ok": true },
    { "path": "/api/health", "status": 200, "ms": 41, "ok": true },
    { "path": "/api/health/ready", "status": 200, "ms": 65, "ok": true },
    { "path": "/plans", "status": 200, "ms": 174, "ok": true },
    { "path": "/robots.txt", "status": 200, "ms": 39, "ok": true }
  ],
  "assets": ["/_next/static/chunks/main-app-4b2f1.js", "/_next/static/css/site-7f90a.css"],
  "chat": {
    "enabled": true,
    "attempted": true,
    "status": "ok",
    "replyPreview": "Opa. Sou uma AAI — Advanced Artificial Intelligence...",
    "replyChars": 212,
    "provider": "mistral",
    "markdownDetected": false,
    "pollAttempts": 2,
    "tookMs": 5160
  },
  "errors": [],
  "okRate": 1,
  "verdict": "warm_ok"
}
```

Como ler:

| Campo | Significado |
| ----- | ----------- |
| `coldStart` | `true` = o primeiro pedido teve de acordar a instância (lento); a ronda seguinte devia sair `warm_ok` |
| `steps[]` | um item por pedido: `path`, `status` HTTP, `ms` (latência) e `ok` |
| `chat.status` | `ok` (200 final) / `skipped` (desativado ou fora da janela) / `timeout` / `error` |
| `chat.markdownDetected` | `true` = detectado markdown na resposta da IA (secção 11) |
| `okRate` | fração de steps com `ok=true` (0..1) |
| `verdict` | `warm_ok` / `degraded` / `failed` |
| `errors[]` | falhas de rede/excepções por pedido; vazio = nada a reportar |

## 11. Notas

- **`/api/health/ready` é o readiness real**: confirma a DB ligada; `/api/health` é apenas liveness do processo. Para saber se a AKIRA está realmente utilizável, guia-te pelo `ready` — não por um ping.
- **Sem mutations perigosas**: as únicas escritas são o perfil do próprio convidado (`POST /api/auth/profile`) e a mensagem de chat. Nunca toca em dados de terceiros nem em configurações do serviço.
- **Quotas de chat**: convidado = **10 msgs/dia**; com as janelas default (`9,15,21` UTC) são **3 chats/dia** — folga para retries e disparos manuais.
- **Auditoria de markdown**: a exigência do produto é "responder sem markdown". O simulador aplica uma **heurística** à resposta — deteta blocos de código (fences de 3 crases), títulos (`##`), negrito/itálico (`**`), links (`[texto](url)`), listas (`- `, `1.`) e tabelas (`|`) — e marca `chat.markdownDetected` (`true`/`false`). Forma barata de auditar a regra sem revisão manual.
- **Estado best-effort**: a gravação em `SIM_STATE_DIR` nunca derruba uma ronda; sem disco (Vercel read-only, runner sem cache) a simulação continua sem sessão persistida.
- **Fixe o alvo num só sítio**: `TARGET_URL` é a fonte única do destino; nada mais no repo precisa de apontar a `akira-ia.onrender.com`.

### Estado validado (ronda real de 2026-10-20, contra a cópia de produção)

- **Navegação HTTP**: `warm_ok`, `okRate 1.0`, sem cold start — `/`, assets `/_next/static/**`, `/api/auth/session`, `/api/billing`, `/api/health`, `/api/health/ready`, `/login`, `robots.txt`/`sitemap.xml` todos 200.
- **Chromium real (msedge headless)**: `/` ~4,9 s, depois clicou na navegação interna → `/plans`, `/tasks`, `/login`, tudo 200, **zero erros de consola**.
- **Chat real**: `202` com `jobId` → resposta em ~5,2 s, `provider mistral`, 212 caracteres, **`markdownDetected: false`** — a resposta de invenção GPT surgiu em texto corrido, conforme pede o produto ("responder sem markdown").
- **Fix aplicado na AKIRA UI (`Cachinde/Akira-IA` commit `a1fe42a`)**: `parseUiSpec` inexistente no final de jobs de texto que desviava respostas bem-sucedidas para o estado "O pedido não foi concluído" — typecheck e build passaram a passar; as notificações/toasts dependem disso.

## 12. Licença

Uso **interno da SmartEdge/SoftEdge — AKIRA**. Todos os direitos reservados ao dono do projeto; não distribuir sem autorização.

## Anexo A — Variáveis de ambiente

Todas as opções da simulação, com os defaults de produção:

| Variável | Default | Propósito |
| -------- | ------- | --------- |
| `TARGET_URL` | `https://akira-ia.onrender.com` | Destino da navegação (instância AKIRA UI). |
| `SIM_TOKEN` | *(vazio)* | Se definido, `/api/simulate` exige o token no header `x-presistent-token`, em `Authorization: Bearer <token>` ou em `?token=`. Vazio = endpoint aberto. |
| `SIM_ENABLE_CHAT` | `true` (core); recomenda-se `false` na cópia Vercel | Permite o round-trip real de chat (valida respostas + gera tráfego real). |
| `SIM_CHAT_HOURS` | `9,15,21` (UTC) | Só dentro destas horas o chat é realmente enviado (3 chats/dia, dentro do limite de 10 convidados). `*` = sempre. |
| `SIM_FORCE_CHAT` | *(vazio)* | `"1"` força o chat fora das horas definidas — para testes. |
| `SIM_CHAT_POLL_SECONDS` | `45` | Tempo máximo de espera pela resposta da IA (polling do `jobId`). |
| `SIM_ASSETS_MAX` | `3` | Quantos assets `/_next/static` pedir por ronda. |
| `SIM_TIMEOUT_MS` | `15000` | Timeout por pedido. |
| `SIM_JITTER_MS` | `120,900` | Pausa aleatória entre pedidos, em ms (formato `min,max`). |
| `SIM_STATE_DIR` | `sim/state` | Onde grava a sessão/cookies para retomar a sessão (cookie jar persistente evita criar utilizador novo na DB a cada ronda; se a escrita falhar, continua sem estado). |
| `SIM_INTERVAL_SECONDS` | `180` | Intervalo entre rondas no modo loop (Docker/local). |
| `SIM_UA` | *(vazio)* | User-Agent fixo; por omissão é escolhido aleatoriamente por ronda de um pool de Chrome modernos. |
| `SIM_BROWSER` | `0` | (Docker) `1` = usou o modo Chromium real por ronda (browsers da imagem Playwright). |
| `SIM_BROWSER_MAX_ROUTES` | `4` | (modo Chromium) nº máximo de rotas navegadas por ronda. |
| `SIM_SCREENSHOT` | *(vazio)* | (modo Chromium) `1` = grava screenshot final em `sim/state/last-browser.png`. |
| `SIM_EXE` | *(vazio)* | (modo Chromium) caminho do executável do browser; por omissão deteta Chrome/Edge nas localizações do sistema, browsers de `/ms-playwright` (imagem Docker) ou `@sparticuz/chromium` (serverless). |
| `SIM_CHAT_PROFILE` | `Presistent Guard` | Display name usado no perfil do convidado ao enviar o chat. |
| `VERCEL_SIM_URL` | *(secret do Actions)* | Secrets do GitHub Actions: se definidos, a ronda do Actions também dispara a mesma simulação na instância Vercel `https://presisenet.vercel.app`. |
| `VERCEL_SIM_TOKEN` | *(secret do Actions)* | Token do disparo à Vercel (header `x-presistent-token`). |

Extra, só na cópia Vercel: `CRON_SECRET` (opcional) autentica o disparo do cron diário configurado no `vercel.json`.

## Anexo B — Estrutura do repositório

```
PRESITEN/
  sim/
    target.mjs        # alvo https://akira-ia.onrender.com + rotas da AKIRA UI
    session.mjs       # cookie jar + pool de User-Agents + headers realistas
    simulator.mjs     # motor: steps, jitter, relatório, heurística de markdown
    run.mjs           # CLI: uma ronda (flag --chat)
    loop.mjs          # modo contínuo (SIM_INTERVAL_SECONDS)
    browser.mjs       # modo Chromium real (Playwright): cliques, scroll, consola
    state/            # session.json + last-browser.png (criados em runtime)
  api/
    simulate.mjs      # GET/POST /api/simulate — ronda serverless (Vercel)
    status.mjs        # GET /api/status — estado rápido (Vercel)
  public/
    index.html        # painel manual com botão "Correr simulação"
  browserSimulator.js # façade de compatibilidade → sim/browser.mjs
  .github/workflows/
    keep-alive.yml    # cron */10 (node direto no runner) + disparo opcional à Vercel
    docker-build.yml  # build da imagem (manual / paths)
  vercel.json         # cron diário + maxDuration 60 + framework null/outputDirectory public
  docker/
    Dockerfile        # mcr playwright + docker-entry.sh (HTTP core | SIM_BROWSER=1 → Chromium)
  docker-entry.sh     # escolhe modo HTTP vs Chromium no container
  docker-compose.yml
  package.json        # scripts: sim | sim:chat | browser | loop
  README.md
  .env.example
```
