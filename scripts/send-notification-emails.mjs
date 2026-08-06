// Polls the `notifications` collection for docs with `emailed: false`, resolves each
// `recipient` display name to an address via the `users` directory (populated client-side
// on sign-in -- see upsertUserDirectory in index.html), and emails them through Resend.
//
// Run on a schedule by .github/workflows/notify-email.yml (Firestore Admin SDK works fine on
// the Spark/free plan -- this deliberately avoids Cloud Functions, which require Blaze).
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT (service account JSON, as a string),
// RESEND_API_KEY, EMAIL_FROM. FIRESTORE_EMULATOR_HOST may be set for local/emulator testing.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function resolveEmail(name) {
  const snap = await db.collection("users").where("name", "==", name).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].data().email || null;
}

async function sendEmail(to, subject, body) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [to],
      subject,
      text: body
    })
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

async function main() {
  const pending = await db.collection("notifications").where("emailed", "==", false).get();
  let sent = 0;
  let skipped = 0;

  for (const docSnap of pending.docs) {
    const notif = docSnap.data();
    const update = { emailed: true };
    try {
      const email = await resolveEmail(notif.recipient);
      if (!email) {
        update.emailError = "no email on file for recipient (they haven't signed in since this feature shipped)";
        skipped++;
      } else {
        const itemLabel = notif.taskName || notif.itemTitle || "";
        const subject = notif.type === "mention"
          ? `${notif.author} mentioned you${itemLabel ? " in " + itemLabel : ""}`
          : `${notif.author} commented${itemLabel ? " on " + itemLabel : ""}`;
        await sendEmail(email, subject, notif.snippet || "");
        sent++;
      }
    } catch (err) {
      update.emailError = String(err.message || err);
      skipped++;
    }
    await docSnap.ref.update(update);
  }

  console.log(`${sent} sent, ${skipped} skipped`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
