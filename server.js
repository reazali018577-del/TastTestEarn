const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;

app.use(express.json());
app.use(express.static("public"));

/*
  TastTestEarn advertiser credit packages.

  These Stars prices are temporary business-test prices.
  We can change them later before launching publicly.
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
  Basic server test.
*/
app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    app: "TastTestEarn",
    message: "TastTestEarn server is running!"
  });
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

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: `${selectedPackage.name} Credits`,
          description: `${selectedPackage.credits} TastTestEarn advertiser credits`,
          payload,
          currency: "XTR",
          prices: [
            {
              label: `${selectedPackage.credits} Credits`,
              amount: selectedPackage.stars
            }
          ]
        })
      }
    );

    const result = await telegramResponse.json();

    if (!result.ok) {
      console.error("Telegram invoice error:", result);

      return res.status(500).json({
        success: false,
        message: "Telegram could not create the payment invoice."
      });
    }

    res.json({
      success: true,
      invoiceUrl: result.result,
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
  Start server.
*/
app.listen(PORT, "0.0.0.0", () => {
  console.log(`TastTestEarn running on port ${PORT}`);
});
