import express from "express";
import cors from "cors";

// Timber Mitten Co. API — a single small Express server, meant to run as a
// Render "Web Service." This replaces two separate Netlify Functions
// (send-notification.mts, remove-bg.mts) with equivalent routes on one
// always-running server, since Render doesn't auto-detect individual
// function files the way Netlify does.
//
// Because the static site and this API now live on two different Render
// URLs (a "Static Site" and a "Web Service" get separate subdomains),
// requests from the browser are cross-origin — unlike on Netlify, where
// relative paths like /.netlify/functions/... stayed same-origin. That's
// why this server explicitly sets CORS headers below; skipping that would
// make the browser block every request.
//
// Setup on Render:
//   1. Push this whole project to a GitHub repo (server.js, package.json,
//      and your site's static files).
//   2. In Render: New > Web Service, connect the repo, root directory
//      pointing at this folder. Build command: npm install.
//      Start command: npm start.
//   3. Add environment variables (Render dashboard > Environment):
//        RESEND_API_KEY      — from resend.com
//        REMOVE_BG_API_KEY   — from remove.bg (optional — only needed if
//                               you turn background removal on)
//        ALLOWED_ORIGIN      — the exact URL of your static site, e.g.
//                               https://timber-mitten-co.onrender.com
//   4. Once deployed, Render gives this service its own URL, e.g.
//      https://timber-mitten-api.onrender.com — update API_BASE in
//      index.html to point at it (see the comment there).

const app = express();
app.use(express.json({ limit: "20mb" })); // generous limit: payloads carry base64 photos

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: ALLOWED_ORIGIN }));

const NOTIFY_TO = "mittentimber@gmail.com";
const RESEND_FROM = "Timber Mitten Co. <onboarding@resend.dev>"; // swap for your verified domain once you have one

function dataUrlToAttachment(dataUrl, filename) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || "");
  if (!match) return null;
  return { filename, content: match[2] };
}

app.get("/", (req, res) => {
  res.send("Timber Mitten Co. API is running.");
});

// ============================================================
// POST /api/send-notification
// Same two payload shapes as the old Netlify function:
//   { type: "image_upload", filename, imageDataUrl }
//   { type: "order", items: [{name,size,price,thumb,notes}], total, uploadedImages }
// ============================================================
app.post("/api/send-notification", async (req, res) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).send("Missing RESEND_API_KEY environment variable.");
  }

  const body = req.body || {};
  let subject = "";
  let html = "";
  const attachments = [];

  if (body.type === "image_upload") {
    const filename = body.filename || "uploaded-image";
    subject = `New image uploaded — ${filename}`;
    html = `<p>A customer uploaded an image in the Design Your Own builder.</p><p><strong>Filename:</strong> ${filename}</p>`;
    const att = dataUrlToAttachment(body.imageDataUrl, filename);
    if (att) attachments.push(att);
  } else if (body.type === "order") {
    const items = Array.isArray(body.items) ? body.items : [];
    subject = `Design submitted — customer sent to Etsy ($${body.total ?? "?"})`;
    const rows = items
      .map(
        (it) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #ddd;">${it.name ?? ""}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #ddd;">${it.size ?? ""}"</td>
        <td style="padding:6px 10px;border-bottom:1px solid #ddd;">$${it.price ?? ""}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #ddd;">${it.notes ?? ""}</td>
      </tr>`
      )
      .join("");
    html = `
      <p>A customer finished designing this piece and was redirected to Etsy to complete their purchase. This confirms they reached checkout — it doesn't confirm the Etsy order itself, so check Etsy for the matching sale before producing anything.</p>
      <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
        <tr style="background:#f1e9d8;">
          <th style="padding:6px 10px;text-align:left;">Item</th>
          <th style="padding:6px 10px;text-align:left;">Size</th>
          <th style="padding:6px 10px;text-align:left;">Price</th>
          <th style="padding:6px 10px;text-align:left;">Notes</th>
        </tr>
        ${rows}
      </table>
      <p><strong>Total: $${body.total ?? "?"}</strong></p>
    `;
    items.forEach((it, i) => {
      const att = dataUrlToAttachment(it.thumb, `item-${i + 1}.png`);
      if (att) attachments.push(att);
    });
    const uploadedImages = Array.isArray(body.uploadedImages) ? body.uploadedImages : [];
    uploadedImages.forEach((dataUrl, i) => {
      const att = dataUrlToAttachment(dataUrl, `uploaded-photo-${i + 1}.png`);
      if (att) attachments.push(att);
    });
  } else {
    return res.status(400).send("Unknown notification type");
  }

  try {
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [NOTIFY_TO],
        subject,
        html,
        attachments: attachments.length ? attachments : undefined,
      }),
    });
    if (!resendRes.ok) {
      const errText = await resendRes.text();
      return res.status(resendRes.status).send(`Resend error (${resendRes.status}): ${errText}`);
    }
  } catch (err) {
    return res.status(502).send(`Could not reach Resend: ${String(err)}`);
  }

  res.status(200).send("OK");
});

// ============================================================
// POST /api/remove-bg
// { image: "data:...;base64,..." } -> raw PNG bytes
// ============================================================
app.post("/api/remove-bg", async (req, res) => {
  const apiKey = process.env.REMOVE_BG_API_KEY;
  if (!apiKey) {
    return res.status(500).send("Missing REMOVE_BG_API_KEY environment variable.");
  }

  const dataUrl = req.body?.image;
  if (!dataUrl || !dataUrl.startsWith("data:")) {
    return res.status(400).send("Expected a base64 data URL in the 'image' field");
  }
  const base64 = dataUrl.split(",")[1] ?? "";
  if (!base64) {
    return res.status(400).send("Could not read image data from the provided data URL");
  }

  const form = new FormData();
  form.append("image_file_b64", base64);
  form.append("size", "auto");

  let rbRes;
  try {
    rbRes = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: { "X-Api-Key": apiKey },
      body: form,
    });
  } catch (err) {
    return res.status(502).send(`Could not reach remove.bg: ${String(err)}`);
  }

  if (!rbRes.ok) {
    const errText = await rbRes.text();
    return res.status(rbRes.status).send(`remove.bg error (${rbRes.status}): ${errText}`);
  }

  const imageBuffer = Buffer.from(await rbRes.arrayBuffer());
  res.set("Content-Type", "image/png");
  res.status(200).send(imageBuffer);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Timber Mitten Co. API listening on port ${PORT}`));
