const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const WEBHOOK_URL =
  process.env.WEBHOOK_URL ||
  "https://tasttestearn.onrender.com/telegram-webhook";

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5
});

app.use(express.json());
app.use(express.static("public"));

/*
  TastTestEarn advertiser credit packages.
*/
const CREDIT_PACKAGES = {
  starter: {
    name: "Starter",
    credits: 100,
    stars: 10
  },
  basic: {
    name: "Basic",
    credits: 550,
    stars: 50
  },
  standard: {
    name: "Standard",
    credits: 1200,
    stars: 100
  },
  business: {
    name: "Business",
    credits: 3250,
    stars: 250
  }
};

/*
  Check that Telegram Web App initData really came from Telegram.
*/
function validateTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) {
    return null;
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) {
    return null;
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calculatedHash !== hash) {
    return null;
  }

  const userString = params.get("user");

  if (!userString) {
    return null;
  }

  try {
    return JSON.parse(userString);
  } catch {
    return null;
  }
}

/*
  Call Telegram Bot API.
*/
async function telegramApi(method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  return response.json();
}

/*
  Create database tables.
*/
async function initializeDatabase() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS advertisers (
      telegram_user_id BIGINT PRIMARY KEY,
      credits INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_orders (
      order_id TEXT PRIMARY KEY,
      telegram_user_id BIGINT NOT NULL,
      package_id TEXT NOT NULL,
      credits INTEGER NOT NULL,
      stars INTEGER NOT NULL,
      payload TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      telegram_payment_charge_id TEXT UNIQUE,
      provider_payment_charge_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );
  `);

  console.log("Database initialized successfully.");
}

/*
  Basic server test.
*/
app.get("/api/status", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      app: "TastTestEarn",
      database: "connected",
      message: "TastTestEarn server is running!"
    });
  } catch (error) {
    console.error("Database status error:", error);

    res.status(500).json({
      success: false,
      app: "TastTestEarn",
      database: "error",
      message: "Database connection failed."
    });
  }
});

/*
  Get the logged-in advertiser's credit balance.
*/
app.post("/api/wallet", async (req, res) => {
  try {
    const { initData } = req.body;

    if (!initData) {
      return res.status(400).json({
        success: false,
        message: "Missing Telegram authentication data."
      });
    }

    const telegramUser = validateTelegramInitData(initData);

    if (!telegramUser || !telegramUser.id) {
      return res.status(401).json({
        success: false,
        message: "Telegram authentication could not be verified."
      });
    }

    /*
      Create advertiser account if it does not exist.
    */
    await pool.query(
      `
      INSERT INTO advertisers
      (
        telegram_user_id,
        credits
      )
      VALUES ($1, 0)
      ON CONFLICT (telegram_user_id)
      DO NOTHING
      `,
      [telegramUser.id]
    );

    /*
      Get current credit balance.
    */
    const result = await pool.query(
      `
      SELECT credits
      FROM advertisers
      WHERE telegram_user_id = $1
      `,
      [telegramUser.id]
    );

    const credits = result.rows[0]
      ? result.rows[0].credits
      : 0;

    res.json({
      success: true,
      credits
    });

  } catch (error) {
    console.error("Wallet error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load wallet."
    });
  }
});
/*
  Create a Telegram Stars invoice.
*/
app.post("/api/create-invoice", async (req, res) => {
  try {
    if (!BOT_TOKEN) {
      return res.status(500).json({
        success: false,
        message: "BOT_TOKEN is not configured on the server."
      });
    }

    const { packageId, initData } = req.body;

    if (!packageId || !initData) {
      return res.status(400).json({
        success: false,
        message: "Missing packageId or Telegram authentication data."
      });
    }

    const telegramUser = validateTelegramInitData(initData);

    if (!telegramUser || !telegramUser.id) {
      return res.status(401).json({
        success: false,
        message: "Telegram authentication could not be verified."
      });
    }

    const selectedPackage = CREDIT_PACKAGES[packageId];

    if (!selectedPackage) {
      return res.status(400).json({
        success: false,
        message: "Invalid credit package."
      });
    }

    const orderId =
      "TTE-" +
      Date.now() +
      "-" +
      crypto.randomBytes(5).toString("hex");

    const payload = JSON.stringify({
      orderId,
      userId: telegramUser.id,
      packageId
    });

    /*
      Save the order BEFORE creating the invoice.
    */
    await pool.query(
      `
      INSERT INTO credit_orders
      (
        order_id,
        telegram_user_id,
        package_id,
        credits,
        stars,
        payload,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
      `,
      [
        orderId,
        telegramUser.id,
        packageId,
        selectedPackage.credits,
        selectedPackage.stars,
        payload
      ]
    );

    const telegramResponse = await telegramApi(
      "createInvoiceLink",
      {
        title: `${selectedPackage.name} Credits`,
        description:
          `${selectedPackage.credits} TastTestEarn advertiser credits`,
        payload,
        currency: "XTR",
        prices: [
          {
            label: `${selectedPackage.credits} Credits`,
            amount: selectedPackage.stars
          }
        ]
      }
    );

    if (!telegramResponse.ok) {
      console.error(
        "Telegram invoice error:",
        telegramResponse
      );

      await pool.query(
        `
        UPDATE credit_orders
        SET status = 'cancelled'
        WHERE order_id = $1
        `,
        [orderId]
      );

      return res.status(500).json({
        success: false,
        message: "Telegram could not create the payment invoice."
      });
    }

    res.json({
      success: true,
      invoiceUrl: telegramResponse.result,
      orderId,
      package: selectedPackage
    });
  } catch (error) {
    console.error("Create invoice error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to create payment invoice."
    });
  }
});

/*
  Telegram webhook.
*/
app.post("/telegram-webhook", async (req, res) => {
  try {
    const update = req.body;

    /*
      PRE-CHECKOUT
    */
    if (update.pre_checkout_query) {
      const query = update.pre_checkout_query;

      try {
        const payload = JSON.parse(query.invoice_payload);

        const result = await pool.query(
          `
          SELECT *
          FROM credit_orders
          WHERE order_id = $1
          `,
          [payload.orderId]
        );

        if (result.rows.length === 0) {
          await telegramApi("answerPreCheckoutQuery", {
            pre_checkout_query_id: query.id,
            ok: false,
            error_message: "Order not found."
          });

          return res.sendStatus(200);
        }

        const order = result.rows[0];

        const valid =
          order.status === "pending" &&
          String(order.telegram_user_id) === String(query.from.id) &&
          query.currency === "XTR" &&
          Number(query.total_amount) === Number(order.stars) &&
          order.package_id === payload.packageId;

        if (!valid) {
          await telegramApi("answerPreCheckoutQuery", {
            pre_checkout_query_id: query.id,
            ok: false,
            error_message:
              "This order could not be verified. Please try again."
          });

          return res.sendStatus(200);
        }

        await telegramApi("answerPreCheckoutQuery", {
          pre_checkout_query_id: query.id,
          ok: true
        });

        return res.sendStatus(200);
      } catch (error) {
        console.error(
          "Pre-checkout processing error:",
          error
        );

        await telegramApi("answerPreCheckoutQuery", {
          pre_checkout_query_id: query.id,
          ok: false,
          error_message:
            "Unable to verify this order. Please try again."
        });

        return res.sendStatus(200);
      }
    }

    /*
      SUCCESSFUL PAYMENT
    */
    if (
      update.message &&
      update.message.successful_payment
    ) {
      const payment =
        update.message.successful_payment;

      const telegramUserId =
        update.message.from &&
        update.message.from.id;

      try {
        const payload = JSON.parse(
          payment.invoice_payload
        );

        await pool.query("BEGIN");

        const result = await pool.query(
          `
          SELECT *
          FROM credit_orders
          WHERE order_id = $1
          FOR UPDATE
          `,
          [payload.orderId]
        );

        if (result.rows.length === 0) {
          await pool.query("ROLLBACK");

          console.error(
            "Successful payment received for unknown order:",
            payload.orderId
          );

          return res.sendStatus(200);
        }

        const order = result.rows[0];

        /*
          Prevent duplicate crediting.
        */
        if (order.status === "paid") {
          await pool.query("COMMIT");

          return res.sendStatus(200);
        }

        const validPayment =
          String(order.telegram_user_id) ===
            String(telegramUserId) &&
          payment.currency === "XTR" &&
          Number(payment.total_amount) ===
            Number(order.stars) &&
          order.package_id === payload.packageId;

        if (!validPayment) {
          await pool.query("ROLLBACK");

          console.error(
            "Invalid successful payment data:",
            payment
          );

          return res.sendStatus(200);
        }

        /*
          Mark payment as paid.
        */
        await pool.query(
          `
          UPDATE credit_orders
          SET
            status = 'paid',
            telegram_payment_charge_id = $1,
            provider_payment_charge_id = $2,
            paid_at = NOW()
          WHERE order_id = $3
          `,
          [
            payment.telegram_payment_charge_id,
            payment.provider_payment_charge_id || null,
            order.order_id
          ]
        );

        /*
          Create advertiser account if necessary.
        */
        await pool.query(
          `
          INSERT INTO advertisers
          (
            telegram_user_id,
            credits
          )
          VALUES ($1, 0)
          ON CONFLICT (telegram_user_id)
          DO NOTHING
          `,
          [order.telegram_user_id]
        );

        /*
          Add purchased credits.
        */
        await pool.query(
          `
          UPDATE advertisers
          SET
            credits = credits + $1,
            updated_at = NOW()
          WHERE telegram_user_id = $2
          `,
          [
            order.credits,
            order.telegram_user_id
          ]
        );

        await pool.query("COMMIT");

        console.log(
          `Payment successful: ${order.order_id} -> +${order.credits} credits`
        );

        return res.sendStatus(200);
      } catch (error) {
        try {
          await pool.query("ROLLBACK");
        } catch {}

        console.error(
          "Successful payment processing error:",
          error
        );

        return res.sendStatus(500);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);

    res.sendStatus(500);
  }
});

/*
  Set Telegram webhook.
*/
async function configureTelegramWebhook() {
  if (!BOT_TOKEN) {
    console.log(
      "BOT_TOKEN is missing. Telegram webhook was not configured."
    );
    return;
  }

  try {
    const result = await telegramApi(
      "setWebhook",
      {
        url: WEBHOOK_URL,
        allowed_updates: [
          "pre_checkout_query",
          "message"
        ]
      }
    );

    console.log(
      "Telegram webhook result:",
      result
    );
  } catch (error) {
    console.error(
      "Telegram webhook setup error:",
      error
    );
  }
}

/*
  Start server.
*/
async function startServer() {
  try {
    await initializeDatabase();

    app.listen(
      PORT,
      "0.0.0.0",
      async () => {
        console.log(
          `TastTestEarn running on port ${PORT}`
        );

        await configureTelegramWebhook();
      }
    );
  } catch (error) {
    console.error(
      "Server startup failed:",
      error
    );

    process.exit(1);
  }
}

startServer();
