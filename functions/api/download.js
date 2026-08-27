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

async function verifyPurchase(context, sessionId, product) {
  if (!context.env.STRIPE_SECRET_KEY) {
    return { error: errorResponse("Download service is not configured yet.", 503) };
  }

  if (!context.env.DOWNLOADS) {
    return { error: errorResponse("Download storage is not configured yet.", 503) };
  }

  const stripeResponse = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    {
      headers: {
        Authorization: `Bearer ${context.env.STRIPE_SECRET_KEY}`,
      },
    }
  );

  if (!stripeResponse.ok) {
    if (stripeResponse.status === 401) {
      return {
        error: errorResponse(
          "Stripe rejected the Production API key. Please update the live STRIPE_SECRET_KEY in Cloudflare.",
          403
        ),
      };
    }

    if (stripeResponse.status === 404) {
      return {
        error: errorResponse(
          "This Checkout Session was created in a different Stripe account or environment than the Production API key.",
          403
        ),
      };
    }

    return {
      error: errorResponse(
        `Stripe verification failed with status ${stripeResponse.status}.`,
        403
      ),
    };
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

  const now = Math.floor(Date.now() / 1000);
  if (!session.created || now - session.created > MAX_SESSION_AGE_SECONDS) {
    return {
      error: errorResponse(
        "This secure download link has expired. Please contact RLT Music & Film Works for assistance.",
        410
      ),
    };
  }

  return { session };
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const sessionId = url.searchParams.get("session_id");
  const productId = url.searchParams.get("product");
  const verifyOnly = url.searchParams.get("verify") === "1";
  const product = PRODUCTS[productId];

  if (!sessionId || !sessionId.startsWith("cs_") || !product) {
    return errorResponse("Invalid download request.", 400);
  }

  const verification = await verifyPurchase(context, sessionId, product);
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
