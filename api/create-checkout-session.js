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
 *   PUBLIC_SITE_URL     — e.g. https://cardello.com (used for redirect URLs)
 *
 * The finished card design (image + message) is stored on the session as
 * metadata so the webhook can hand it to the print fulfillment step once
 * payment succeeds. Stripe metadata values are capped at 500 characters —
 * for production, store the full design in a database/object storage and
 * pass a short reference id here instead of the raw data URL.
 */

function toFormBody(obj, prefix) {
  const parts = [];
  for (const key in obj) {
    const value = obj[key];
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
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

    const params = {
      mode: "payment",
      success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/create.html`,
      shipping_address_collection: { allowed_countries: ["US", "CA"] },
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
        // NOTE: data-URL images are long; Stripe metadata values cap at 500 chars.
        // In production, upload the design to storage first and put its URL here instead.
        designUrl: (designUrl || "").slice(0, 480),
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
