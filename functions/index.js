/* ═══════════════════════════════════════════════════════════════════
 * Cloud Function — Aviso de RECUSA por DM no Slack (Aceite LGPD)
 * ───────────────────────────────────────────────────────────────────
 * Dispara quando um documento novo entra em "aceites_marketing".
 * Se a resposta for "recusado" (cliente clicou "Não quero receber"),
 * manda uma MENSAGEM DIRETA (DM) para o(s) responsável(is) da loja.
 *
 * Não usa canal: usa um Bot Token do Slack (chat.postMessage) e envia
 * DM direto pra cada pessoa configurada abaixo.
 *
 * Roda em southamerica-east1 (São Paulo) — mesma região dos dados.
 * O Bot Token fica como SECRET, nunca no código.
 *
 * Deploy:  firebase deploy --only functions
 * ═══════════════════════════════════════════════════════════════════ */

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions/v2");

// Segredo — definido por:  firebase functions:secrets:set SLACK_BOT_TOKEN
// (é o "Bot User OAuth Token", começa com xoxb-)
const SLACK_BOT_TOKEN = defineSecret("SLACK_BOT_TOKEN");

/* ── Quem recebe a DM em cada loja ──────────────────────────────────
 * Chave = `valor` da loja (o mesmo do <select> no index.html).
 * Valor = LISTA de Member IDs do Slack (perfil → ⋮ → "Copiar ID do
 * membro"; começa com U ou W). Pode ter 1 ou várias pessoas por loja.
 * Deixe [] pra não avisar ninguém daquela loja.
 * ─────────────────────────────────────────────────────────────────── */
const RESPONSAVEL_POR_LOJA = {
  "espaco-revendedor-penedo":   ["U0895CZ8HU7"],   // Espaço do Revendedor Penedo (fallback: você)
  "espaco-revendedor-palmeira": ["U0895CZ8HU7"],   // Espaço do Revendedor Palmeira dos Índios (fallback: você)
  "loja-palmeira":              ["U0AL2NDNH09"],   // Loja Palmeira dos Índios
  "loja-teotonio-vilela":       ["U087P8JF97F"],   // Loja Teotônio Vilela
  "loja-coruripe":              ["U08NLNHF29G"],   // Loja Coruripe
  "loja-palmeira-sustentavel":  ["U0AL2NDNH09"],   // Loja Palmeira Sustentável (mesma pessoa da Palmeira dos Índios)
  "loja-sao-sebastiao":         ["U09ED214T6W"],   // Loja São Sebastião
  "loja-penedo":                ["U092FQKNFPB"],   // Loja Penedo
};

/* Pessoas que recebem a DM de TODA recusa, seja qual for a loja.
 * Útil pro encarregado de dados (DPO). Deixe [] se não quiser. */
const SEMPRE_AVISAR = [];

/* Fallback: recusa SEM loja identificada (ex.: cliente que aceitou ANTES de a
 * loja passar a ser salva no aparelho, e depois cancelou pelo modo expresso)
 * cai aqui — assim nenhuma recusa some sem avisar ninguém. */
const FALLBACK_SEM_LOJA = ["U0895CZ8HU7"];

// Rótulos "bonitos" das lojas (o doc guarda só o `valor`).
const NOME_DA_LOJA = {
  "espaco-revendedor-penedo":   "Espaço do Revendedor Penedo",
  "espaco-revendedor-palmeira": "Espaço do Revendedor Palmeira dos Índios",
  "loja-palmeira":              "Loja Palmeira dos Índios",
  "loja-teotonio-vilela":       "Loja Teotônio Vilela",
  "loja-coruripe":              "Loja Coruripe",
  "loja-palmeira-sustentavel":  "Loja Palmeira Sustentável",
  "loja-sao-sebastiao":         "Loja São Sebastião",
  "loja-penedo":                "Loja Penedo",
};

/* 5582999998888 → +55 (82) 99999-8888  (só cosmético; se vier fora do
 * padrão, devolve como está). */
function formatarTelefone(tel) {
  if (typeof tel !== "string" || !/^55\d{10,11}$/.test(tel)) return tel || "—";
  const ddd = tel.slice(2, 4);
  const n = tel.slice(4);
  return n.length === 9
    ? `+55 (${ddd}) ${n.slice(0, 5)}-${n.slice(5)}`
    : `+55 (${ddd}) ${n.slice(0, 4)}-${n.slice(4)}`;
}

function formatarQuando(registradoEm) {
  // registradoEm é um Timestamp do Firestore; cai pra "agora" se faltar.
  const data = registradoEm && typeof registradoEm.toDate === "function"
    ? registradoEm.toDate()
    : new Date();
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(data);
}

// Manda UMA DM (chat.postMessage com o user id como "channel").
// A API do Slack devolve HTTP 200 mesmo em erro lógico — o que vale é
// o campo "ok" do corpo.
async function enviarDM(token, userId, texto, blocks) {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: userId, text: texto, blocks }),
  });
  const corpo = await resp.json().catch(() => ({}));
  if (!corpo.ok) {
    throw new Error(`Slack recusou DM p/ ${userId}: ${corpo.error || resp.status}`);
  }
}

exports.avisarRecusa = onDocumentCreated(
  {
    document: "aceites_marketing/{protocolo}",
    region: "southamerica-east1",
    secrets: [SLACK_BOT_TOKEN],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const d = snap.data() || {};

    // Só recusas — aceites e qualquer outra coisa são ignorados.
    if (d.resposta !== "recusado") return;

    const protocolo = event.params.protocolo;
    const loja = d.loja || "";
    const nomeLoja = NOME_DA_LOJA[loja] || loja || "— (não identificada)";
    const telefone = formatarTelefone(d.telefone);
    const quando = formatarQuando(d.registradoEm);
    const nome = d.nome || "—";

    // Destinatários = responsáveis da loja + quem sempre recebe (sem repetir).
    let destinatarios = [
      ...new Set([...(RESPONSAVEL_POR_LOJA[loja] || []), ...SEMPRE_AVISAR]),
    ];

    // Recusa sem loja/responsável NÃO pode sumir — cai no fallback.
    if (destinatarios.length === 0) {
      logger.warn("Recusa sem loja/responsável — indo pro fallback", { loja, protocolo });
      destinatarios = [...new Set(FALLBACK_SEM_LOJA)];
    }
    if (destinatarios.length === 0) {
      logger.error("Recusa sem destinatário e fallback vazio", { loja, protocolo });
      return;
    }

    const textoSimples =
      `🚫 Recusa registrada — ${nomeLoja} · ${nome} · ${telefone}`;

    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: "🚫 Recusa registrada", emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Loja:*\n${nomeLoja}` },
          { type: "mrkdwn", text: `*Cliente:*\n${nome}` },
          { type: "mrkdwn", text: `*WhatsApp:*\n${telefone}` },
          { type: "mrkdwn", text: `*Quando:*\n${quando}` },
        ],
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Protocolo \`${protocolo}\`` }],
      },
    ];

    const token = SLACK_BOT_TOKEN.value();

    // Manda pra todos; se uma DM falhar, as outras seguem.
    const resultados = await Promise.allSettled(
      destinatarios.map((uid) => enviarDM(token, uid, textoSimples, blocks))
    );

    const falhas = resultados.filter((r) => r.status === "rejected");
    if (falhas.length) {
      falhas.forEach((f) => logger.error(String(f.reason), { protocolo, loja }));
      // Se TODAS falharam, lança pra aparecer como erro no log.
      if (falhas.length === destinatarios.length) {
        throw new Error(`Nenhuma DM entregue (loja ${loja}, protocolo ${protocolo})`);
      }
    }

    logger.info("Aviso de recusa enviado por DM", {
      protocolo,
      loja,
      enviados: destinatarios.length - falhas.length,
      total: destinatarios.length,
    });
  }
);
