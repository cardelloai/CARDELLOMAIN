/**
 * POST /api/stripe-webhook
 *
 * Listens for Stripe's `checkout.session.completed` event and places the
 * print order with a print-on-demand partner (Prodigi by default) so the
 * card actually gets printed and shipped — no manual step required.
 *
 * Verifies the Stripe signature by hand (HMAC-SHA256 via Node's built-in
 * `crypto`), so no `stripe` npm package is required to deploy this.
 *
 * Required env vars:
 *   STRIPE_WEBHOOK_SECRET — from your Stripe Dashboard webhook endpoint
 *   PRODIGI_API_KEY       — from your Prodigi account
 *   PRODIGI_SKU           — the Prodigi product SKU for your card stock/size
 *                            (set up one SKU per size in Prodigi and branch
 *                            on metadata.cardSize below if you offer more
 *                            than one)
 *
 * IMPORTANT: this handler needs the RAW request body to verify the Stripe
 * signature, so body parsing is disabled for this route via the
 * `module.exports.config` line at the bottom of this file (Vercel reads
 * that to skip its automatic JSON body parsing for this function).
 */

const crypto = require("crypto");

function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k, v];
    })
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const signatureBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function placePrintOrder(session) {
  const meta = session.metadata || {};
  const shipping = session.shipping_details || session.customer_details || {};
  const address = (shipping.address || {});

  const orderPayload = {
    shippingMethod: "Standard",
    recipient: {
      name: shipping.name || session.customer_details?.name || "Customer",
      address: {
        line1: address.line1,
        line2: address.line2 || "",
        postalOrZipCode: address.postal_code,
        countryCode: address.country,
        townOrCity: address.city,
        stateOrCounty: address.state || "",
      },
    },
    items: [
      {
        sku: process.env.PRODIGI_SKU || "GLOBAL-CARD-5x7",
        copies: 1,
        assets: [{ printArea: "default", url: meta.designUrl }],
        recipientCustomText: meta.message || "",
      },
    ],
    metadata: {
      cardelloSessionId: session.id,
      occasion: meta.occasion || "",
      recipientName: meta.recipientName || "",
    },
  };

  const resp = await fetch("https://api.prodigi.com/v4.0/Orders", {
    method: "POST",
    headers: {
      "X-API-Key": process.env.PRODIGI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(orderPayload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Prodigi order failed: ${resp.status} ${errText}`);
  }

  return resp.json();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["stripe-signature"];

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET is not set — refusing to process webhook.");
    res.status(500).end();
    return;
  }

  const valid = verifyStripeSignature(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    res.status(400).send("Invalid signature");
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    res.status(400).send("Invalid payload");
    return;
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    try {
      if (process.env.PRODIGI_API_KEY) {
        await placePrintOrder(session);
      } else {
        console.warn("PRODIGI_API_KEY not set — skipping print order for session", session.id);
      }
    } catch (err) {
      console.error("Fulfillment error for session", session.id, err);
      // Respond 200 anyway so Stripe doesn't retry into a duplicate order;
      // alert yourself out-of-band (e.g. log monitoring, email) on this path.
    }
  }

  res.status(200).json({ received: true });
};

module.exports.config = { api: { bodyParser: false } };
