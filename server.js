const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const admin = require("firebase-admin");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

// Monta credenciais Firebase a partir de variáveis de ambiente
const serviceAccount = {
  type: process.env.FB_TYPE,
  project_id: process.env.FB_PROJECT_ID,
  private_key_id: process.env.FB_PRIVATE_KEY_ID,
  private_key: process.env.FB_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  client_email: process.env.FB_CLIENT_EMAIL,
  client_id: process.env.FB_CLIENT_ID,
  auth_uri: process.env.FB_AUTH_URI,
  token_uri: process.env.FB_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FB_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FB_CLIENT_CERT_URL,
  universe_domain: process.env.FB_UNIVERSE_DOMAIN,
};

// Inicializa Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const firestore = admin.firestore();

// Credenciais Mercado Pago
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || null;

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Normaliza email em ID do Firestore
function emailToUserId(email) {
  return email.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
}

// Healthcheck
app.get("/", (req, res) => {
  res.send("Webhook backend online ✅");
});

// Webhook Mercado Pago
app.post("/api/mp-webhook", async (req, res) => {
  try {
    const paymentId =
      (req.body && req.body.data && req.body.data.id) ||
      (req.body && req.body.id) ||
      req.query["data.id"] ||
      req.query.id;

    const tipo =
      (req.body && req.body.type) ||
      req.query.type;

    if (tipo !== "payment" || !paymentId) {
      console.log("Webhook ignorado:", { body: req.body, query: req.query });
      return res.status(200).send("ignored");
    }

    if (MP_WEBHOOK_SECRET) {
      const headerSecret =
        req.headers["x-signature"] ||
        req.headers["x-hook-secret"] ||
        req.headers["x-webhook-secret"];

      if (!headerSecret || headerSecret !== MP_WEBHOOK_SECRET) {
        console.warn("Assinatura inválida no webhook!");
        return res.status(401).send("unauthorized");
      }
    }

    if (!MP_ACCESS_TOKEN) {
      console.error("Sem MP_ACCESS_TOKEN!");
      return res.status(500).send("missing access token");
    }

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
      console.error("Erro Mercado Pago:", await mpResp.text());
      return res.status(500).send("mp fetch fail");
    }

    const paymentData = await mpResp.json();
    console.log("paymentData:", paymentData);

    if (paymentData.status !== "approved") {
      console.log("Pagamento não aprovado ainda:", paymentData.status);
      return res.status(200).send("pending/not-approved");
    }

    const payerEmail =
      paymentData &&
      paymentData.payer &&
      paymentData.payer.email;

    if (!payerEmail) {
      console.error("Aprovado mas sem payer.email");
      return res.status(500).send("no payer email");
    }

    const userId = emailToUserId(payerEmail);

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

    console.log(`Usuário ${payerEmail} liberado como premium ✅`);
    return res.status(200).send("ok");
  } catch (err) {
    console.error("Erro no webhook:", err);
    return res.status(500).send("error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Servidor rodando na porta " + PORT);
});
