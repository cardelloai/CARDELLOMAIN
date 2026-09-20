/**
 * POST /api/stripe-webhook
 *
 * Listens for Stripe's `checkout.session.completed` event and emails you
 * (the shop owner) the finished order — a print-ready PDF (front cover
 * design on page 1, the customer's message centered on a plain background
 * on page 2, sized to the card size they picked), plus the shipping address
 * — so you can print it on your own printer, fold it, and mail it yourself.
 * This is the self-fulfillment path; there's no automatic print-on-demand
 * step here.
 *
 * Verifies the Stripe signature by hand (HMAC-SHA256 via Node's built-in
 * `crypto`), so no `stripe` npm package is required to deploy this.
 * Sends email via Resend's REST API directly (plain fetch), so no `resend`
 * npm package is required either. Builds the print-ready PDF with `pdf-lib`.
 *
 * Required env vars:
 *   STRIPE_WEBHOOK_SECRET — from your Stripe Dashboard webhook endpoint
 *   RESEND_API_KEY        — from resend.com (free tier is plenty for this)
 *   NOTIFY_EMAIL           — the email address YOU want new orders sent to
 *   NOTIFY_FROM_EMAIL      — optional; defaults to Resend's shared sending
 *                            address (onboarding@resend.dev), which needs no
 *                            setup. Use your own domain here once you've
 *                            verified it in Resend, for a more professional
 *                            "from" address.
 *
 * IMPORTANT: this handler needs the RAW request body to verify the Stripe
 * signature, so body parsing is disabled for this route via the
 * `module.exports.config` line at the bottom of this file (Vercel reads
 * that to skip its automatic JSON body parsing for this function).
 */

const crypto = require("crypto");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

// Card sizes in PDF points at 72 DPI (matches the sizes offered at checkout).
const CARD_DIMENSIONS = {
  standard: { width: 360, height: 504 }, // 5x7"
  large: { width: 504, height: 720 }, // 7x10"
};

function wrapText(text, font, fontSize, maxWidth) {
  const paragraphs = String(text || "").split(/\n+/);
  const lines = [];
  paragraphs.forEach((paragraph) => {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = "";
    words.forEach((word) => {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    });
    lines.push(current);
  });
  return lines;
}

/** Builds a print-ready PDF: page 1 is the front cover design, page 2 is
 *  the customer's message centered on a plain cream background. Returns
 *  the PDF as a Buffer, or null if the design image couldn't be fetched. */
async function buildPrintPdf({ designUrl, message, cardSize }) {
  const dims = CARD_DIMENSIONS[cardSize] || CARD_DIMENSIONS.standard;
  const pdfDoc = await PDFDocument.create();

  // Page 1: front cover design.
  if (designUrl) {
    try {
      const imgResp = await fetch(designUrl);
      if (imgResp.ok) {
        const contentType = imgResp.headers.get("content-type") || "";
        const imgBytes = Buffer.from(await imgResp.arrayBuffer());
        const image = contentType.includes("png")
          ? await pdfDoc.embedPng(imgBytes)
          : await pdfDoc.embedJpg(imgBytes);
        const page1 = pdfDoc.addPage([dims.width, dims.height]);
        page1.drawImage(image, { x: 0, y: 0, width: dims.width, height: dims.height });
      }
    } catch (err) {
      console.error("Could not embed design image into PDF:", err);
    }
  }

  // Page 2: the message, centered on a plain cream background.
  const page2 = pdfDoc.addPage([dims.width, dims.height]);
  page2.drawRectangle({
    x: 0,
    y: 0,
    width: dims.width,
    height: dims.height,
    color: rgb(0.98, 0.97, 0.94),
  });

  const font = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
  const fontSize = 16;
  const lineHeight = fontSize + 8;
  const margin = 48;
  const maxWidth = dims.width - margin * 2;
  const lines = wrapText(message || "", font, fontSize, maxWidth);

  let y = dims.height / 2 + (lines.length * lineHeight) / 2 - lineHeight / 2;
  lines.forEach((line) => {
    const textWidth = font.widthOfTextAtSize(line, fontSize);
    page2.drawText(line, {
      x: (dims.width - textWidth) / 2,
      y,
      size: fontSize,
      font,
      color: rgb(0.15, 0.15, 0.15),
    });
    y -= lineHeight;
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

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

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function sendOrderNotificationEmail(session) {
  const meta = session.metadata || {};
  const shipping = session.shipping_details || session.customer_details || {};
  const address = shipping.address || {};
  const customerEmail = session.customer_details?.email || "";
  const customerName = shipping.name || session.customer_details?.name || "Customer";

  const addressLines = [
    address.line1,
    address.line2,
    [address.city, address.state, address.postal_code].filter(Boolean).join(", "),
    address.country,
  ]
    .filter(Boolean)
    .join("<br>");

  const amountDisplay = session.amount_total != null ? `$${(session.amount_total / 100).toFixed(2)}` : "";

  const html = `
    <h2>New Cardello order 🎉</h2>
    <p><strong>Total paid:</strong> ${escapeHtml(amountDisplay)}</p>
    <p><strong>Occasion:</strong> ${escapeHtml(meta.occasion || "")}</p>
    <p><strong>Card size / finish:</strong> ${escapeHtml(meta.cardSize || "standard")} / ${escapeHtml(
    meta.finish || "matte"
  )}</p>
    <p><strong>Recipient name (as told to us):</strong> ${escapeHtml(meta.recipientName || "")}</p>
    <h3>Ship to</h3>
    <p>${escapeHtml(customerName)}<br>${addressLines}</p>
    <p><strong>Customer email (for questions):</strong> ${escapeHtml(customerEmail)}</p>
    <h3>Message to print inside the card</h3>
    <p style="white-space: pre-wrap; border-left: 3px solid #ccc; padding-left: 12px;">${escapeHtml(
      meta.message || ""
    )}</p>
    <h3>Card design (front cover)</h3>
    ${
      meta.designUrl
        ? `<p><a href="${escapeHtml(meta.designUrl)}">${escapeHtml(meta.designUrl)}</a></p>
           <img src="${escapeHtml(meta.designUrl)}" alt="Card design" style="max-width:400px; border:1px solid #ddd;" />`
        : `<p><em>No design image URL was saved for this order — check the Stripe dashboard for session ${escapeHtml(
            session.id
          )}.</em></p>`
    }
    <p><strong>📎 A print-ready PDF is attached to this email</strong> — page 1 is the front cover, page 2 is the
      message, both sized for a ${escapeHtml(meta.cardSize || "standard")} card. Just print, fold, and mail.</p>
    <p style="color:#888; font-size:12px;">Stripe session: ${escapeHtml(session.id)}</p>
  `;

  let attachments;
  try {
    const pdfBuffer = await buildPrintPdf({
      designUrl: meta.designUrl,
      message: meta.message,
      cardSize: meta.cardSize,
    });
    if (pdfBuffer) {
      attachments = [
        {
          filename: `cardello-order-${session.id}.pdf`,
          content: pdfBuffer.toString("base64"),
        },
      ];
    }
  } catch (err) {
    console.error("Could not build print-ready PDF for session", session.id, err);
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.NOTIFY_FROM_EMAIL || "Cardello Orders <onboarding@resend.dev>",
      to: [process.env.NOTIFY_EMAIL],
      subject: `New order — ${meta.occasion || "Cardello card"} for ${meta.recipientName || "a customer"}`,
      html,
      ...(attachments ? { attachments } : {}),
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Order notification email failed: ${resp.status} ${errText}`);
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
      if (process.env.RESEND_API_KEY && process.env.NOTIFY_EMAIL) {
        await sendOrderNotificationEmail(session);
      } else {
        console.warn(
          "RESEND_API_KEY or NOTIFY_EMAIL not set — skipping order notification email for session",
          session.id
        );
      }
    } catch (err) {
      console.error("Order notification error for session", session.id, err);
      // Respond 200 anyway so Stripe doesn't retry into a duplicate email;
      // check Vercel's function logs if an order's email doesn't arrive.
    }
  }

  res.status(200).json({ received: true });
};

module.exports.config = { api: { bodyParser: false } };
