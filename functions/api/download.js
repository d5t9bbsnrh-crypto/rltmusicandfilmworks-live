// Production deployment trigger after adding STRIPE_SECRET_KEY: 2026-08-27
const PRODUCTS = {
  radio: {
    amountSubtotal: 499,
    objectKey: "The-Funk-Strut-radio.zip",
    filename: "The-Funk-Strut-radio.zip",
  },
  "12inch": {
    amountSubtotal: 1099,
    objectKey: "The-Funk-Strut-12-inch.zip",
    filename: "The-Funk-Strut-12-inch.zip",
  },
};

const MAX_SESSION_AGE_SECONDS = 7 * 24 * 60 * 60;

function errorResponse(message, status) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function normalizeStripeId(rawValue, prefix) {
  if (!rawValue) return null;
  const cleaned = String(rawValue).trim().replace(/\\/g, "");
  const match = cleaned.match(new RegExp(`${prefix}[A-Za-z0-9_]+`));
  return match ? match[0] : null;
}

function stripeLookupError(status) {
  if (status === 401) {
    return errorResponse(
      "Stripe rejected the Production API key. Please update the live STRIPE_SECRET_KEY in Cloudflare.",
      403
    );
  }

  if (status === 404) {
    return errorResponse(
      "This Stripe payment was created in a different Stripe account or environment than the Production API key.",
      403
    );
  }

  return errorResponse(`Stripe verification failed with status ${status}.`, 403);
}

function isFresh(created) {
  const now = Math.floor(Date.now() / 1000);
  return created && now - created <= MAX_SESSION_AGE_SECONDS;
}

async function verifyCheckoutSession(context, sessionId, product) {
  const stripeResponse = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    {
      headers: {
        Authorization: `Bearer ${context.env.STRIPE_SECRET_KEY}`,
      },
    }
  );

  if (!stripeResponse.ok) {
    return { error: stripeLookupError(stripeResponse.status) };
  }

  const session = await stripeResponse.json();

  if (
    session.mode !== "payment" ||
    session.status !== "complete" ||
    session.payment_status !== "paid" ||
    session.currency !== "usd" ||
    session.amount_subtotal !== product.amountSubtotal
  ) {
    return { error: errorResponse("Payment verification failed for this download.", 403) };
  }

  if (!isFresh(session.created)) {
    return {
      error: errorResponse(
        "This secure download link has expired. Please contact RLT Music & Film Works for assistance.",
        410
      ),
    };
  }

  return { stripeObject: session };
}

async function verifyPaymentIntent(context, paymentIntentId, product) {
  const stripeResponse = await fetch(
    `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`,
    {
      headers: {
        Authorization: `Bearer ${context.env.STRIPE_SECRET_KEY}`,
      },
    }
  );

  if (!stripeResponse.ok) {
    return { error: stripeLookupError(stripeResponse.status) };
  }

  const paymentIntent = await stripeResponse.json();
  const paidAmount = paymentIntent.amount_received || paymentIntent.amount;

  if (
    paymentIntent.status !== "succeeded" ||
    paymentIntent.currency !== "usd" ||
    paidAmount !== product.amountSubtotal
  ) {
    return { error: errorResponse("Payment verification failed for this download.", 403) };
  }

  if (!isFresh(paymentIntent.created)) {
    return {
      error: errorResponse(
        "This secure download link has expired. Please contact RLT Music & Film Works for assistance.",
        410
      ),
    };
  }

  return { stripeObject: paymentIntent };
}

async function verifyPurchase(context, sessionId, paymentIntentId, product) {
  if (!context.env.STRIPE_SECRET_KEY) {
    return { error: errorResponse("Download service is not configured yet.", 503) };
  }

  if (!context.env.DOWNLOADS) {
    return { error: errorResponse("Download storage is not configured yet.", 503) };
  }

  const normalizedSessionId = normalizeStripeId(sessionId, "cs_");
  const normalizedPaymentIntentId = normalizeStripeId(paymentIntentId, "pi_");

  if (normalizedSessionId) {
    return verifyCheckoutSession(context, normalizedSessionId, product);
  }

  if (normalizedPaymentIntentId) {
    return verifyPaymentIntent(context, normalizedPaymentIntentId, product);
  }

  return { error: errorResponse("Invalid download request.", 400) };
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const sessionId = url.searchParams.get("session_id");
  const paymentIntentId = url.searchParams.get("payment_intent") || url.searchParams.get("pi");
  const productId = url.searchParams.get("product");
  const verifyOnly = url.searchParams.get("verify") === "1";
  const product = PRODUCTS[productId];

  if (!product) {
    return errorResponse("Invalid download request.", 400);
  }

  const verification = await verifyPurchase(
    context,
    sessionId,
    paymentIntentId,
    product
  );
  if (verification.error) return verification.error;

  if (verifyOnly) {
    const object = await context.env.DOWNLOADS.head(product.objectKey);
    if (!object) {
      return errorResponse("The purchased download file is temporarily unavailable.", 404);
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }

  const object = await context.env.DOWNLOADS.get(product.objectKey);
  if (!object) {
    return errorResponse("The purchased download file is temporarily unavailable.", 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/zip");
  headers.set("Content-Disposition", `attachment; filename="${product.filename}"`);
  headers.set("Content-Length", object.size.toString());
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  if (object.httpEtag) headers.set("ETag", object.httpEtag);

  return new Response(object.body, { headers });
}

export function onRequest(context) {
  if (context.request.method !== "GET") {
    return errorResponse("Method not allowed.", 405);
  }
  return onRequestGet(context);
}
