/**
 * INTEL MONITOR — Backend Gratuito
 * Só recebe mensagens do WhatsApp e repassa via WebSocket.
 * Sem dependência paga — análise IA feita no frontend.
 */

require("dotenv").config();
const express   = require("express");
const http      = require("http");
const WebSocket = require("ws");
const cors      = require("cors");

const PORT         = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "INTEL_TOKEN";
const ORIGINS      = (process.env.ALLOWED_ORIGINS || "*").split(",");

// ── App ───────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(cors({ origin: ORIGINS }));
app.use("/webhook/whatsapp", express.raw({ type: "*/*" }));
app.use(express.json());

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss     = new WebSocket.Server({ server, path: "/ws" });
const clients = new Set();
let   history = [];   // últimas 200 mensagens

function broadcast(data) {
  const json = JSON.stringify(data);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(json); });
}

wss.on("connection", ws => {
  clients.add(ws);
  // envia histórico ao conectar
  ws.send(JSON.stringify({ type: "INIT", payload: { messages: history } }));
  ws.on("close", () => clients.delete(ws));
});

// ── Webhook WhatsApp ──────────────────────────────────────────────────────────
app.get("/webhook/whatsapp", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.send(challenge);
  res.sendStatus(403);
});

app.post("/webhook/whatsapp", (req, res) => {
  res.sendStatus(200); // responde imediatamente à Meta

  try {
    const body = JSON.parse(req.body.toString());
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        for (const waMsg of value?.messages || []) {
          if (waMsg.type !== "text") continue;

          const contact = value.contacts?.find(c => c.wa_id === waMsg.from);
          const agent   = (contact?.profile?.name || `WA:${waMsg.from.slice(-4)}`)
                            .toUpperCase().replace(/\s+/g, "-");
          const time    = new Date(parseInt(waMsg.timestamp) * 1000)
                            .toLocaleTimeString("pt-BR");

          const msg = {
            id:          `wa_${waMsg.id}`,
            agent,
            time,
            text:        waMsg.text.body,
            fromWhatsapp: true,
          };

          history.push(msg);
          if (history.length > 200) history = history.slice(-200);

          broadcast({ type: "NEW_MESSAGE", payload: { message: msg } });
          console.log(`[WA] ${agent}: ${msg.text.slice(0, 60)}`);
        }
      }
    }
  } catch (err) {
    console.error("[WA] Erro:", err.message);
  }
});

// ── API manual (para testes) ──────────────────────────────────────────────────
app.post("/api/messages", (req, res) => {
  const { agent, text } = req.body;
  if (!agent || !text) return res.status(400).json({ error: "agent e text obrigatórios" });

  const msg = {
    id:          `manual_${Date.now()}`,
    agent:       agent.toUpperCase(),
    time:        new Date().toLocaleTimeString("pt-BR"),
    text:        text.trim(),
    fromWhatsapp: false,
  };
  history.push(msg);
  broadcast({ type: "NEW_MESSAGE", payload: { message: msg } });
  res.json({ ok: true, message: msg });
});

app.delete("/api/clear", (req, res) => {
  history = [];
  broadcast({ type: "CLEAR" });
  res.json({ ok: true });
});

app.get("/health", (req, res) =>
  res.json({ status: "ok", clients: clients.size, messages: history.length }));

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  INTEL MONITOR BACKEND`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  ws://localhost:${PORT}/ws`);
  console.log(`  VERIFY_TOKEN: ${VERIFY_TOKEN}\n`);
});
