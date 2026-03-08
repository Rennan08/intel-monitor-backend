/**
 * INTEL MONITOR — Backend 100% Gratuito
 * WhatsApp Webhook + WebSocket + Análise IA via Groq (grátis)
 *
 * Groq: https://groq.com — crie conta, gere API key, cole no .env
 */

require("dotenv").config();
const express   = require("express");
const http      = require("http");
const WebSocket = require("ws");
const cors      = require("cors");

const PORT         = process.env.PORT            || 3000;
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "INTEL_TOKEN";
const ORIGINS      = (process.env.ALLOWED_ORIGINS || "*").split(",");
const GROQ_KEY     = process.env.GROQ_API_KEY    || "";

const app    = express();
const server = http.createServer(app);

app.use(cors({ origin: ORIGINS }));
app.use("/webhook/whatsapp", express.raw({ type: "*/*" }));
app.use(express.json());

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss     = new WebSocket.Server({ server, path: "/ws" });
const clients = new Set();
let   history  = [];
let   analyses = {};

function broadcast(data) {
  const json = JSON.stringify(data);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(json); });
}

wss.on("connection", ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "INIT", payload: { messages: history, analyses } }));
  ws.on("message", (data) => {
    try {
      const { type } = JSON.parse(data);
      if (type === "PING") ws.send(JSON.stringify({ type: "PONG" }));
    } catch(_) {}
  });
  ws.on("close", () => clients.delete(ws));
});

// ── Análise com Groq (gratuito) ───────────────────────────────────────────────
async function analyzeWithGroq(msg) {
  if (!GROQ_KEY) return null;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.1,
        max_tokens: 500,
        messages: [
          {
            role: "system",
            content: `Você é um sistema de análise de inteligência operacional. Analise mensagens de agentes em campo e retorne APENAS JSON válido, sem markdown, sem backticks, sem texto extra.

Formato exato:
{"prioridade":"CRÍTICA|ALTA|MÉDIA|BAIXA","resumo":"resumo em 1 frase","veiculos":["placas/modelos"],"individuos":["nomes/apelidos"],"locais":["endereços/pontos"],"eventos":["ações relevantes"],"acao_recomendada":"sugestão ou null"}

Critérios:
- CRÍTICA: ameaça imediata, confronto, disparos, fuga em andamento
- ALTA: suspeito identificado em movimento, veículo ativo rastreado
- MÉDIA: observação de rotina com elementos suspeitos
- BAIXA: informação de contexto sem urgência`,
          },
          {
            role: "user",
            content: `Agente: ${msg.agent}\nHorário: ${msg.time}\nMensagem: "${msg.text}"`,
          },
        ],
      }),
    });

    if (!response.ok) throw new Error(`Groq HTTP ${response.status}`);
    const data  = await response.json();
    const raw   = data.choices?.[0]?.message?.content || "{}";
    return JSON.parse(raw.replace(/```json|```/g, "").trim());

  } catch (err) {
    console.error("[IA] Erro Groq:", err.message);
    return { prioridade:"BAIXA", resumo:"Erro na análise.", veiculos:[], individuos:[], locais:[], eventos:[], acao_recomendada:null };
  }
}

// ── Processar mensagem ────────────────────────────────────────────────────────
async function processMessage(msg) {
  history.push(msg);
  if (history.length > 200) history = history.slice(-200);

  // Transmite imediatamente — análise vem logo depois
  broadcast({ type: "NEW_MESSAGE", payload: { message: msg } });
  console.log(`[WA] ${msg.agent}: ${msg.text.slice(0, 70)}`);

  const analysis = await analyzeWithGroq(msg);
  if (analysis) {
    analyses[msg.id] = analysis;
    broadcast({ type: "NEW_ANALYSIS", payload: { msgId: msg.id, analysis } });
    if (analysis.prioridade === "CRÍTICA" || analysis.prioridade === "ALTA") {
      console.warn(`[ALERTA] ${analysis.prioridade} — ${msg.agent}: ${analysis.resumo}`);
    }
  }
}

// ── Webhook WhatsApp ──────────────────────────────────────────────────────────
app.get("/webhook/whatsapp", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.send(challenge);
  res.sendStatus(403);
});

app.post("/webhook/whatsapp", (req, res) => {
  res.sendStatus(200);
  try {
    const body = JSON.parse(req.body.toString());
    if (body.object !== "whatsapp_business_account") return;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        for (const waMsg of value?.messages || []) {
          if (waMsg.type !== "text") continue;
          const contact = value.contacts?.find(c => c.wa_id === waMsg.from);
          const agent   = (contact?.profile?.name || `WA:${waMsg.from.slice(-4)}`).toUpperCase().replace(/\s+/g, "-");
          const time    = new Date(parseInt(waMsg.timestamp) * 1000).toLocaleTimeString("pt-BR");
          processMessage({ id:`wa_${waMsg.id}`, agent, time, text:waMsg.text.body, fromWhatsapp:true });
        }
      }
    }
  } catch (err) { console.error("[WA] Erro:", err.message); }
});

// ── API manual ────────────────────────────────────────────────────────────────
app.post("/api/messages", async (req, res) => {
  const { agent, text } = req.body;
  if (!agent || !text) return res.status(400).json({ error: "agent e text obrigatórios" });
  const msg = { id:`manual_${Date.now()}`, agent:agent.toUpperCase(), time:new Date().toLocaleTimeString("pt-BR"), text:text.trim(), fromWhatsapp:false };
  await processMessage(msg);
  res.json({ ok:true, message:msg, analysis:analyses[msg.id]||null });
});

app.delete("/api/clear", (req, res) => {
  history = []; analyses = {};
  broadcast({ type:"CLEAR" });
  res.json({ ok:true });
});

app.get("/health", (req, res) =>
  res.json({ status:"ok", clients:clients.size, messages:history.length, groq: GROQ_KEY ? "ativo" : "sem chave" })
);

server.listen(PORT, () => {
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  INTEL MONITOR BACKEND`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  ws://localhost:${PORT}/ws`);
  console.log(`  Groq IA: ${GROQ_KEY ? "✓ ativo" : "✗ sem chave — adicione GROQ_API_KEY"}`);
  console.log(`═══════════════════════════════════════\n`);
});
