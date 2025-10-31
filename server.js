const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const admin = require("firebase-admin");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config(); // carrega variáveis do .env

// carrega a chave de serviço do Firebase Admin
const serviceAccount = require("./serviceAccountKey.json");

// inicializa o Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const firestore = admin.firestore();

// pega credenciais do Mercado Pago do .env
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || null;

const app = express();
app.use(cors());
app.use(bodyParser.json());

// mesma função que você usa no front pra gerar o ID do Firestore a partir do e-mail
function emailToUserId(email) {
  return email.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
}

// rota teste
app.get("/", (req, res) => {
  res.send("Webhook backend online ✅");
});

// rota que o Mercado Pago vai chamar
app.post("/api/mp-webhook", async (req, res) => {
  try {
    // tenta pegar o ID do pagamento de vários jeitos
    const paymentId =
      (req.body && req.body.data && req.body.data.id) ||
      (req.body && req.body.id) ||
      req.query["data.id"] ||
      req.query.id;

    const tipo = (req.body && req.body.type) || req.query.type;

    // se não for notificação de pagamento, ignora
    if (tipo !== "payment" || !paymentId) {
      console.log("Webhook recebido mas ignorado:", req.body);
      return res.status(200).send("ignored");
    }

    // valida segredo, se você configurou
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

    // consulta o Mercado Pago pra pegar detalhes do pagamento
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
      console.error("Erro consultando pagamento no MP:", await mpResp.text());
      return res.status(500).send("mp fetch fail");
    }

    const paymentData = await mpResp.json();
    console.log("paymentData:", paymentData);

    // só libera premium se aprovado
    if (paymentData.status !== "approved") {
      console.log("Pagamento não aprovado ainda:", paymentData.status);
      return res.status(200).send("pending/not-approved");
    }

    // pega e-mail do comprador
    const payerEmail =
      paymentData &&
      paymentData.payer &&
      paymentData.payer.email;

    if (!payerEmail) {
      console.error("Pagamento aprovado mas sem payer.email!");
      return res.status(500).send("no payer email");
    }

    // gera ID igual ao front
    const userId = emailToUserId(payerEmail);

    // atualiza Firestore marcando premium
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

    res.status(200).send("ok");
  } catch (err) {
    console.error("Erro no webhook:", err);
    res.status(500).send("error");
  }
});

// sobe o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
