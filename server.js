// server.js
const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const cors = require("cors");
const dotenv = require("dotenv");
const fetch = require("node-fetch"); // IMPORTANTE: buscar detalhes do pagamento no MP

dotenv.config();

/**
 * ============= FIREBASE ADMIN SETUP =============
 * Variáveis de ambiente esperadas no Render (.env):
 *
 * FB_TYPE=service_account
 * FB_PROJECT_ID=emagreca-com-saude-4528d
 * FB_PRIVATE_KEY_ID=...
 * FB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n... \n-----END PRIVATE KEY-----\n"
 * FB_CLIENT_EMAIL=firebase-adminsdk-xxx@emagreca-com-saude-4528d.iam.gserviceaccount.com
 * FB_CLIENT_ID=...
 * FB_AUTH_URI=https://accounts.google.com/o/oauth2/auth
 * FB_TOKEN_URI=https://oauth2.googleapis.com/token
 * FB_AUTH_PROVIDER_CERT_URL=https://www.googleapis.com/oauth2/v1/certs
 * FB_CLIENT_CERT_URL=https://www.googleapis.com/robot/v1/metadata/x509/...
 * FB_UNIVERSE_DOMAIN=googleapis.com
 *
 * IMPORTANTE:
 * - No Render, a private key vem numa linha só. Por isso fazemos .replace(/\\n/g, "\n")
 */

const serviceAccount = {
  type: process.env.FB_TYPE,
  project_id: process.env.FB_PROJECT_ID,
  private_key_id: process.env.FB_PRIVATE_KEY_ID,
  private_key: process.env.FB_PRIVATE_KEY
    ? process.env.FB_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined,
  client_email: process.env.FB_CLIENT_EMAIL,
  client_id: process.env.FB_CLIENT_ID,
  auth_uri: process.env.FB_AUTH_URI,
  token_uri: process.env.FB_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FB_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FB_CLIENT_CERT_URL,
  universe_domain: process.env.FB_UNIVERSE_DOMAIN,
};

// Inicializa Firebase Admin só uma vez
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const firestore = admin.firestore();

/**
 * ============= MERCADO PAGO CONFIG =============
 *
 * Variáveis de ambiente esperadas:
 *
 * MP_ACCESS_TOKEN=APP_USR-6667655271194913-103117-ab36018b61afff15150aab274d4c55be-309139040
 * MP_WEBHOOK_SECRET=ALGUMSEGREDOOPCIONAL  (opcional)
 *
 * IMPORTANTE:
 * - Esse token precisa ser da MESMA conta que gera seu link de pagamento.
 */

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || null;

// ===== Express App =====
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Utilitário: transformar email em ID seguro de doc no Firestore
function emailToUserId(email) {
  return email.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
}

// Healthcheck básico pra testar no navegador
app.get("/", (req, res) => {
  res.send("Webhook backend online ✅");
});

/**
 * ===========================
 *  ROTA: /api/mp-webhook
 *  Recebe notificações do Mercado Pago
 * ===========================
 *
 * O Mercado Pago pode mandar DOIS formatos:
 *
 * Formato novo (Webhooks v1):
 * {
 *   "type": "payment",
 *   "action": "payment.updated",
 *   "data": { "id": "1234567890" },
 *   ...
 * }
 *
 * Formato IPN clássico (o que você logou agora):
 * query: { id: "131461899749", topic: "payment" }
 * body:  { resource: "131461899749", topic: "payment" }
 *
 * Em ambos, precisamos chegar em:
 *   tipo = "payment"
 *   paymentId = "131461899749"
 */
app.post("/api/mp-webhook", async (req, res) => {
  try {
    console.log("🔥 Webhook bruto recebido:");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("🔎 Query params:", req.query);

    // 1. Detectar o tipo do evento:
    // - Em webhooks mais novos vem "type"
    // - Em IPN clássico vem "topic"
    const tipo =
      (req.body && (req.body.type || req.body.topic)) ||
      req.query.type ||
      req.query.topic ||
      null;

    // 2. Pegar o ID do pagamento:
    // - Webhook novo: req.body.data.id
    // - IPN clássico: query.id
    // - Alguns IPNs mandam resource no body
    const paymentId =
      (req.body && req.body.data && req.body.data.id) ||
      (req.query && req.query.id) ||
      (req.body && req.body.resource) ||
      (req.body && req.body.id) ||
      null;

    console.log("➡ tipo:", tipo);
    console.log("➡ paymentId:", paymentId);

    // 3. Se não tem ID ou não é "payment", ignorar educadamente
    if (!paymentId || tipo !== "payment") {
      console.log("🌙 Ignorando webhook irrelevante:", { tipo, paymentId });
      return res.status(200).send("ignored");
    }

    // 4. Validação opcional de segredo
    if (MP_WEBHOOK_SECRET) {
      const headerSecret =
        req.headers["x-signature"] ||
        req.headers["x-hook-secret"] ||
        req.headers["x-webhook-secret"];

      if (!headerSecret || headerSecret !== MP_WEBHOOK_SECRET) {
        console.warn("🚫 Assinatura inválida no webhook!");
        return res.status(401).send("unauthorized");
      }
    }

    // 5. Precisa do token do Mercado Pago para buscar detalhes do pagamento
    if (!MP_ACCESS_TOKEN) {
      console.error("❌ Sem MP_ACCESS_TOKEN definido no ambiente!");
      return res.status(200).send("missing access token");
    }

    // 6. Buscar os detalhes reais do pagamento
    const mpResp = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!mpResp.ok) {
      const erroTexto = await mpResp.text();
      console.error("⚠ Mercado Pago não retornou payment:", erroTexto);

      // Respondemos 200 mesmo assim pra não tomar retry infinito.
      return res.status(200).send("mp fetch fail");
    }

    const paymentData = await mpResp.json();
    console.log("💳 paymentData (MP):");
    console.log(JSON.stringify(paymentData, null, 2));

    // 7. Só libera premium se estiver aprovado
    if (paymentData.status !== "approved") {
      console.log("⌛ Pagamento ainda não aprovado. Status:", paymentData.status);
      return res.status(200).send("pending/not-approved");
    }

    /**
     * 8. Descobrir o email do comprador
     *
     * - metadata.email_app:
     *   Melhor caso: você gera a cobrança dinamicamente no futuro
     *   e injeta o email do usuário logado aqui.
     *
     * - payer.email:
     *   Email da conta que efetuou o pagamento no Mercado Pago.
     *   Pode ser diferente do email de login no app,
     *   mas por enquanto usamos isso como chave.
     */
    const emailFromMetadata =
      paymentData?.metadata?.email_app;

    const emailFromPayer =
      paymentData?.payer?.email;

    const finalEmail = emailFromMetadata || emailFromPayer;

    console.log("👤 email final:", finalEmail);

    if (!finalEmail) {
      console.error("❌ Aprovado mas sem email. Não consigo mapear usuário.");
      return res.status(200).send("approved-but-no-email");
    }

    // 9. Normaliza email -> vira ID do doc no Firestore
    const userId = emailToUserId(finalEmail);

    // 10. Atualiza Firestore marcando premium
    await firestore
      .collection("usuarios")
      .doc(userId)
      .set(
        {
          premium: true,
          premiumLastUpdate: admin.firestore.FieldValue.serverTimestamp(),
          lastPaymentId: paymentId,
        },
        { merge: true }
      );

    console.log(`✅ PREMIUM LIBERADO para ${finalEmail}`);

    // 11. Sempre responde 200 (o Mercado Pago para de reenviar)
    return res.status(200).send("ok");
  } catch (err) {
    console.error("💥 Erro interno no webhook:", err);
    // Ainda devolve 200 pra não ficar em loop eterno
    return res.status(200).send("error");
  }
});

// Sobe servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Servidor rodando na porta " + PORT);
});
