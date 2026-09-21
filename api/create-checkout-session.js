/**
 * POST /api/create-checkout-session
 *
 * Creates a Stripe Checkout Session (Stripe's hosted, PCI-compliant payment
 * page) and returns its URL. The frontend redirects the browser there.
 *
 * Calls Stripe's REST API directly via fetch (form-encoded), so no `stripe`
 * npm package is required to deploy this.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY   — your Stripe secret key (sk_live_... or sk_test_...)
 *   PUBLIC_SITE_URL     — e.g. https://cardello.ca (used for redirect URLs)
 *   BLOB_READ_WRITE_TOKEN — auto-set when you enable Vercel Blob storage on
 *                            this project (Storage tab in the Vercel dashboard)
 *
 * The finished card design is a big base64 image, and Stripe metadata values
 * are capped at 500 characters — far too small to hold it. So before
 * creating the checkout session, we upload the chosen design image to
 * Vercel Blob storage and only put its short public URL in Stripe metadata.
 * The webhook (api/stripe-webhook.js) reads that URL back out once payment
 * succeeds, so you get a working image link in your order-notification email.
 */

const { put } = require("@vercel/blob");

function toFormBody(obj, prefix) {
  const parts = [];
  for (const key in obj) {
    const value = obj[key];
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        const indexedKey = `${fullKey}[${i}]`;
        if (item && typeof item === "object") {
          parts.push(toFormBody(item, indexedKey));
        } else {
          parts.push(`${encodeURIComponent(indexedKey)}=${encodeURIComponent(item)}`);
        }
      });
    } else if (value && typeof value === "object") {
      parts.push(toFormBody(value, fullKey));
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join("&");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(500).json({ error: "Payments aren't configured yet. Set STRIPE_SECRET_KEY to enable checkout." });
    return;
  }

  try {
    const { designUrl, message, cardSize, finish, amount, recipientName, occasion } = req.body || {};

    if (!designUrl || !message || !amount) {
      res.status(400).json({ error: "Missing required order details." });
      return;
    }

    const siteUrl = process.env.PUBLIC_SITE_URL || `https://${req.headers.host}`;
    const amountCents = Math.round(parseFloat(amount) * 100);

    const productName = `Cardello Card — ${cardSize === "large" ? "Large (7x10\")" : "Standard (5x7\")"}, ${
      finish === "glossy" ? "Glossy" : "Matte"
    } finish`;

    // Upload the chosen design to storage and use its short URL instead of
    // the raw (huge) base64 image, which would get truncated by Stripe's
    // 500-character metadata limit.
    let hostedDesignUrl = designUrl;
    const dataUrlMatch = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(designUrl || "");
    if (dataUrlMatch && process.env.BLOB_READ_WRITE_TOKEN) {
      const [, mimeType, base64] = dataUrlMatch;
      const ext = mimeType.split("/")[1] || "png";
      const buffer = Buffer.from(base64, "base64");
      const blob = await put(`cardello-orders/${Date.now()}-design.${ext}`, buffer, {
        access: "public",
        contentType: mimeType,
      });
      hostedDesignUrl = blob.url;
    } else if (dataUrlMatch && !process.env.BLOB_READ_WRITE_TOKEN) {
      console.warn(
        "BLOB_READ_WRITE_TOKEN not set — design image will not survive into the order email. " +
          "Enable Vercel Blob storage on this project to fix this."
      );
    }

    const params = {
      mode: "payment",
      success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/create.html`,
      shipping_address_collection: { allowed_countries: ["US", "CA"] },
      // Flat $2 shipping charge, shown as its own line item at checkout —
      // same for Canada and the US. Card price stays what's shown in the
      // wizard; this is added on top by Stripe.
      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: { amount: 200, currency: "usd" },
            display_name: "Shipping",
          },
        },
      ],
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: String(amountCents),
            product_data: { name: productName },
          },
          quantity: "1",
        },
      ],
      // Metadata is handed to the fulfillment step by the webhook once payment succeeds.
      metadata: {
        recipientName: (recipientName || "").slice(0, 480),
        occasion: (occasion || "").slice(0, 480),
        cardSize: cardSize || "standard",
        finish: finish || "matte",
        message: (message || "").slice(0, 480),
        designUrl: (hostedDesignUrl || "").slice(0, 480),
      },
    };

    const body = toFormBody(params);

    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Stripe error:", errText);
      res.status(502).json({ error: "Could not start checkout with our payment provider." });
      return;
    }

    const session = await resp.json();
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    res.status(500).json({ error: "Something went wrong starting checkout." });
  }
};
