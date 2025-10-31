// -------------------------
// Imports e setup básico
// -------------------------
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const admin = require("firebase-admin");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config(); // carrega variáveis do .env localmente (no Render você usa Environment Variables)

// -------------------------
// Firebase Admin
// -------------------------
const serviceAccount = require("./serviceAccountKey.json");

// Garante que o Firebase só é inicializado uma vez
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const firestore = admin.firestore();

// -------------------------
// Credenciais do Mercado Pago
// -------------------------
// MP_ACCESS_TOKEN: token privado do Mercado Pago (APP_USR-...)
// MP_WEBHOOK_SECRET: senha que você mesmo definiu pra validar quem chama o webhook
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || null;

// Segurança básica: avisa no console se esquecer variáveis importantes
if (!MP_ACCESS_TOKEN) {
  console.warn("⚠ MP_ACCESS_TOKEN não definido! Pagamentos não vão validar.");
}
if (!MP_WEBHOOK_SECRET) {
  console.warn("ℹ MP_WEBHOOK_SECRET não definido. Webhook aceitará qualquer origem.");
}

// -------------------------
// Express app
// -------------------------
const app = express();

app.use(cors());
app.use(bodyParser.json());

// -------------------------
// Helper: gera o ID do usuário no Firestore a partir do e-mail
// Regras: minúsculo e só caracteres seguros
// -------------------------
function emailToUserId(email) {
  return email.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
}

// -------------------------
// Rota de status (GET /)
// Usada só pra ver se o servidor está de pé (Render healthcheck, etc.)
// -------------------------
app.get("/", (req, res) => {
  res.send("Webhook backend online ✅");
});

// -------------------------
// Webhook Mercado Pago (POST /api/mp-webhook)
// Essa rota deve ser cadastrada no painel do Mercado Pago
// Exemplo de URL completa no Render:
// https://seu-servico.onrender.com/api/mp-webhook
// -------------------------
app.post("/api/mp-webhook", async (req, res) => {
  try {
    // 1. Extrair dados básicos da notificação -----------------
    const paymentId =
      (req.body && req.body.data && req.body.data.id) || // formato oficial MP
      (req.body && req.body.id) || // fallback
      req.query["data.id"] || // fallback se veio por querystring
      req.query.id;

    const tipo =
      (req.body && req.body.type) || // geralmente "payment"
      req.query.type;

    // Se não é sobre pagamento ou não temos ID, ignora educadamente
    if (tipo !== "payment" || !paymentId) {
      console.log("🔎 Webhook recebido mas ignorado (não é pagamento válido):", {
        body: req.body,
        query: req.query,
      });
      return res.status(200).send("ignored");
    }

    // 2. Validar segredo do webhook ----------------------------
    // Se você configurou MP_WEBHOOK_SECRET no Render
    // então toda chamada tem que mandar o mesmo valor num header aceito.
    if (MP_WEBHOOK_SECRET) {
      const headerSecret =
        req.headers["x-signature"] || // alguns gateways usam isso
        req.headers["x-hook-secret"] ||
        req.headers["x-webhook-secret"];

      if (!headerSecret || headerSecret !== MP_WEBHOOK_SECRET) {
        console.warn("🚫 Assinatura inválida no webhook!");
        return res.status(401).send("unauthorized");
      }
    }

    // 3. Consultar Mercado Pago pra pegar dados reais do pagamento ----
    // Obs: o simulador deles pode mandar um ID fake tipo "123456",
    // então aqui pode falhar em ambiente de teste. Isso é normal.
    if (!MP_ACCESS_TOKEN) {
      console.error("❌ Sem MP_ACCESS_TOKEN, não consigo validar pagamento!");
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
      console.error(
        "❌ Erro consultando pagamento no Mercado Pago:",
        await mpResp.text()
      );
      // nesse caso devolvemos 500 pra o MP tentar reenviar depois
      return res.status(500).send("mp fetch fail");
    }

    const paymentData = await mpResp.json();
    console.log("💳 paymentData recebido:", paymentData);

    // 4. Só libera premium se o pagamento estiver aprovado -----
    if (paymentData.status !== "approved") {
      console.log(
        `⏳ Pagamento ${paymentId} ainda não aprovado (status=${paymentData.status})`
      );
      return res.status(200).send("pending/not-approved");
    }

    // 5. Pegar e-mail do comprador -----------------------------
    const payerEmail =
      paymentData &&
      paymentData.payer &&
      paymentData.payer.email;

    if (!payerEmail) {
      console.error(
        "⚠ Pagamento aprovado mas sem payer.email! Não sei quem liberar."
      );
      return res.status(500).send("no payer email");
    }

    // 6. Atualizar Firestore marcando premium ------------------
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

    console.log(`✅ Usuário ${payerEmail} liberado como premium.`);

    // 7. Resposta final pro Mercado Pago -----------------------
    return res.status(200).send("ok");
  } catch (err) {
    console.error("💥 Erro interno no webhook:", err);
    return res.status(500).send("error");
  }
});

// -------------------------
// Sobe o servidor
// -------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Servidor rodando na porta " + PORT);
});
