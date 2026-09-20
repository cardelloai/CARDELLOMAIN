# Cardello

AI-personalized greeting cards: a customer answers a few simple questions,
uploads a photo, our AI turns it into custom card art, they pick their
favorite, add a message, pay — and the card gets printed and mailed to the
recipient automatically.

Built as a plain HTML/CSS/JS site with a handful of serverless functions.
**No build step and no npm packages required** — every API call (OpenAI,
Stripe, Prodigi) is made with plain `fetch`, so `npm install` has nothing to
install. That also means it deploys in seconds and there's nothing to break
between Node versions.

## What's inside

```
public/
  index.html       Landing page
  create.html       The card-creation wizard (shell)
  app.js            All wizard logic: occasion → relationship → details →
                     photo → AI generation → pick design → customize →
                     checkout redirect
  success.html      Order confirmation page
  styles.css        All styling — large text, big tap targets, high
                     contrast, designed for an older/less tech-savvy audience
  assets/logo.png   Your logo

api/
  generate-cards.js          Calls OpenAI to generate 4 card design options
                              + a suggested inside message
  create-checkout-session.js Creates a Stripe Checkout session
  stripe-webhook.js          On successful payment, places the print order
                              with Prodigi (print-on-demand)
```

## Before you launch: 3 things to set up

### 1. An OpenAI account (for AI card designs)
Create an API key at platform.openai.com and set it as `OPENAI_API_KEY`.

**Design style:** the current prompt (`api/generate-cards.js`) targets bold,
photorealistic "novelty poster" cards — the customer's real photo, staged in
a fun scene, with a headline ("Happy Birthday!"), a short subheading, and a
few punchy caption labels baked into the image as typography. It works in
two steps: a text model writes the exact headline/subheading/captions first,
then the image model renders the photo + that copy together.

**Test this early and with real photos, checking two things specifically:**
1. **Likeness** — does the photo stay clearly recognizable as that person?
2. **Text accuracy** — image models are much better at rendering text than
   they used to be, but not perfect. Check every generated card for typos or
   garbled letters in the headline/captions before treating this as
   launch-ready. If text quality is inconsistent, consider either
   regenerating automatically when text looks wrong, or offering the
   customer a "regenerate" button.

If likeness quality doesn't hold up, it's worth trying an alternative image
model (Stability AI, Ideogram, Flux via Replicate) — swap the
`generateOneDesign` function in `api/generate-cards.js`.

### 2. A Stripe account (for payments)
Create an account at stripe.com, grab your secret key, and set
`STRIPE_SECRET_KEY`. Start with your **test** key (`sk_test_...`) until
you've placed a few practice orders end-to-end.

Once deployed, add a webhook endpoint in the Stripe Dashboard pointing to
`https://yourdomain.com/api/stripe-webhook`, listening for the
`checkout.session.completed` event. Stripe will give you a signing secret —
set that as `STRIPE_WEBHOOK_SECRET`.

### 3. A print-on-demand account (for fulfillment)
The webhook is wired up for **Prodigi** (prodigi.com), which prints and
ships greeting cards worldwide with no inventory on your end. Create an
account, pick a card product/SKU for your size and stock, and set
`PRODIGI_API_KEY` and `PRODIGI_SKU`. (Prodigi has a sandbox/test mode — use
it until you're confident in the flow.)

If you'd rather use a different printer (Cloudprinter, Gelato, a local print
shop with an API), everything you need to swap is in the `placePrintOrder`
function in `api/stripe-webhook.js`.

## Deploying (recommended: Vercel)

1. Push this folder to a GitHub repo.
2. Go to vercel.com → New Project → import the repo. Vercel auto-detects
   the `api/` folder as serverless functions and serves `public/` as the
   site — no configuration needed.
3. In the Vercel project's Settings → Environment Variables, add the
   variables from `.env.example`.
4. Deploy. Your site is live at the URL Vercel gives you (connect your own
   domain, e.g. cardello.com, under Settings → Domains).
5. Add the Stripe webhook (step 2 above) pointing at your live domain.

Netlify also works, but its functions use a different handler signature —
the `api/*.js` files would need a small adapter (wrapping each `module.exports`
handler in Netlify's `exports.handler` format).

## Local development

You'll need the [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`)
to run the API functions locally, since they need a Node server:

```
vercel dev
```

This serves the site and functions together at `http://localhost:3000`.
Copy `.env.example` to `.env` and fill in test keys first.

Alternatively, to preview just the static pages without any backend calls
(the wizard will fall back to placeholder card designs), you can open
`public/index.html` directly, or run any static file server:

```
npx serve public
```

## Known limitations / next steps

- **No database.** Orders exist only as Stripe Checkout sessions + the
  Prodigi order it triggers. Fine for launch; if you want an order history,
  admin dashboard, or the ability to re-print/refund, add a database (e.g.
  Postgres via Vercel/Supabase/Neon) and write each order to it in the
  webhook.
- **Design images pass through as full data URLs**, capped at 500 characters
  in Stripe metadata. Once you have real traffic, upload generated designs
  to object storage (e.g. Vercel Blob, S3, Cloudinary) in `generate-cards.js`
  and pass a short URL through checkout instead — this is called out inline
  in `create-checkout-session.js`.
- **No accounts/login** — intentionally, to keep the flow as simple as
  possible for an older audience. Order status/tracking would currently
  come from Stripe's emailed receipt and Prodigi's shipping notification.
- **Pricing** is hardcoded in `app.js` (`CARD_PRICE`, `FINISH_ADD`) — update
  those constants as you finalize your margins against Prodigi's per-unit
  cost.
