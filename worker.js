// Bot catatan pengeluaran untuk Telegram (Cloudflare Worker).
//
// Cara pakai (kirim ke bot):
//   - Catat manual : "50rb makan siang"  /  "12000 parkir"  /  "1,5jt sewa"
//   - Foto struk   : kirim foto struk -> total & toko dibaca AI otomatis
//   - /laporan     : rekap hari ini + bulan ini
//   - /total       : total sepanjang waktu
//   - /hapus       : hapus catatan terakhir
//   - /start, /help: bantuan
//
// Yang perlu disiapkan di dashboard Cloudflare Worker:
//   Secrets (Settings > Variables and Secrets, tipe Secret):
//     - BOT_TOKEN       : token dari @BotFather (wajib)
//     - TELEGRAM_SECRET : token rahasia webhook (disarankan)
//     - ALLOWED_IDS     : daftar ID Telegram yang boleh pakai, dipisah koma (privat)
//   Bindings:
//     - KV Namespace  -> variable name: EXPENSES  (penyimpanan catatan)
//     - Workers AI    -> variable name: AI        (untuk baca foto struk)

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Jakarta (UTC+7)
const AI_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export default {
  async fetch(request, env) {
    if (request.method === "POST") return handleTelegram(request, env);
    return new Response("Bot catatan pengeluaran aktif.", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function handleTelegram(request, env) {
  if (env.TELEGRAM_SECRET) {
    const got = request.headers.get("x-telegram-bot-api-secret-token");
    if (got !== env.TELEGRAM_SECRET) return new Response("forbidden", { status: 403 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const msg = update.message || update.edited_message;
  const chatId = msg && msg.chat && msg.chat.id;
  const fromId = msg && msg.from && msg.from.id;
  if (!chatId) return new Response("ok");

  if (!isAllowed(env, fromId, chatId)) {
    await sendMessage(env, chatId, "Maaf, bot ini privat.");
    return new Response("ok");
  }

  try {
    await routeMessage(env, chatId, msg);
  } catch (e) {
    await sendMessage(env, chatId, "Maaf, terjadi error: " + (e && e.message ? e.message : e));
  }
  return new Response("ok");
}

// Tentukan apa yang harus dilakukan dari sebuah pesan.
async function routeMessage(env, chatId, msg) {
  // Foto struk?
  if (Array.isArray(msg.photo) && msg.photo.length) {
    return handleReceiptPhoto(env, chatId, msg);
  }

  const text = (msg.text || "").trim();
  if (!text) {
    return sendMessage(env, chatId, "Kirim catatan (mis. '50rb makan siang') atau foto struk ya.");
  }

  const lower = text.toLowerCase();
  if (lower === "/start" || lower === "/help") return sendMessage(env, chatId, helpText());
  if (lower.startsWith("/laporan")) return sendReport(env, chatId, msg.from.id);
  if (lower.startsWith("/total")) return sendTotal(env, chatId, msg.from.id);
  if (lower.startsWith("/hapus")) return deleteLast(env, chatId, msg.from.id);

  // Selain itu, anggap sebagai catatan manual.
  const parsed = parseEntry(text);
  if (!parsed) {
    return sendMessage(
      env,
      chatId,
      "Format belum kebaca. Contoh: '50rb makan siang', '12000 parkir', '1,5jt sewa'.",
    );
  }
  await addEntry(env, msg.from.id, { ...parsed, src: "teks" });
  return sendMessage(
    env,
    chatId,
    `✅ Tercatat: ${fmtRp(parsed.amount)} — ${parsed.note}`,
  );
}

// Baca foto struk pakai Workers AI, lalu simpan.
async function handleReceiptPhoto(env, chatId, msg) {
  if (!env.AI) {
    return sendMessage(env, chatId, "Fitur foto struk belum aktif (binding Workers AI 'AI' belum diset).");
  }
  await sendMessage(env, chatId, "📸 Membaca struk...");

  // Ambil foto ukuran terbesar.
  const photo = msg.photo[msg.photo.length - 1];
  const bytes = await getTelegramFile(env, photo.file_id);

  const result = await readReceipt(env, bytes);
  if (!result || !result.amount) {
    return sendMessage(
      env,
      chatId,
      "Maaf, total di struk tidak terbaca. Coba foto lebih jelas, atau ketik manual (mis. '50rb belanja').",
    );
  }

  const note = result.toko || (msg.caption || "").trim() || "struk";
  await addEntry(env, msg.from.id, { amount: result.amount, note, src: "foto" });
  return sendMessage(env, chatId, `✅ Tercatat dari struk: ${fmtRp(result.amount)} — ${note}`);
}

// Minta AI mengekstrak total & toko dari gambar struk.
async function readReceipt(env, arrayBuffer) {
  const prompt =
    "Ini foto struk belanja Indonesia. Temukan TOTAL akhir yang dibayar dan nama tokonya. " +
    'Balas HANYA dengan JSON tanpa penjelasan, format: {"total": <angka rupiah, tanpa titik/koma>, "toko": "<nama toko>"}. ' +
    'Kalau tidak yakin, isi total dengan 0.';

  let out;
  try {
    out = await env.AI.run(AI_VISION_MODEL, {
      image: [...new Uint8Array(arrayBuffer)],
      prompt,
      max_tokens: 256,
    });
  } catch (e) {
    return null;
  }

  const raw = (out && (out.response || out.description || "")) + "";
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const amount = Math.round(Number(String(j.total).replace(/[^\d]/g, "")) || 0);
    const toko = (j.toko || "").toString().trim();
    return { amount, toko };
  } catch {
    return null;
  }
}

// Unduh file dari Telegram -> ArrayBuffer.
async function getTelegramFile(env, fileId) {
  const info = await (
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`)
  ).json();
  const path = info && info.result && info.result.file_path;
  if (!path) throw new Error("gagal ambil file dari Telegram");
  const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`);
  return r.arrayBuffer();
}

// ---------------------------------------------------------------------------
// Penyimpanan (Cloudflare KV)
// ---------------------------------------------------------------------------

function kvKey(uid) {
  return `exp:${uid}`;
}

async function getEntries(env, uid) {
  if (!env.EXPENSES) throw new Error("KV 'EXPENSES' belum di-bind");
  const raw = await env.EXPENSES.get(kvKey(uid));
  return raw ? JSON.parse(raw) : [];
}

async function saveEntries(env, uid, list) {
  await env.EXPENSES.put(kvKey(uid), JSON.stringify(list));
}

async function addEntry(env, uid, entry) {
  const list = await getEntries(env, uid);
  list.push({ ts: Date.now(), amount: entry.amount, note: entry.note, src: entry.src });
  await saveEntries(env, uid, list);
}

// ---------------------------------------------------------------------------
// Laporan
// ---------------------------------------------------------------------------

async function sendReport(env, chatId, uid) {
  const list = await getEntries(env, uid);
  if (!list.length) return sendMessage(env, chatId, "Belum ada catatan. Kirim '50rb ...' atau foto struk dulu.");

  const now = wibParts(Date.now());
  const todayKey = now.y * 10000 + now.m * 100 + now.d;
  const monthKey = now.y * 100 + now.m;

  let totalHari = 0;
  let totalBulan = 0;
  const hariIni = [];
  for (const e of list) {
    const p = wibParts(e.ts);
    if (p.y * 100 + p.m === monthKey) totalBulan += e.amount;
    if (p.y * 10000 + p.m * 100 + p.d === todayKey) {
      totalHari += e.amount;
      hariIni.push(e);
    }
  }

  const lines = [`📊 Laporan (${pad(now.d)}/${pad(now.m)}/${now.y})`, ""];
  lines.push(`Hari ini : ${fmtRp(totalHari)}`);
  lines.push(`Bulan ini: ${fmtRp(totalBulan)}`);
  if (hariIni.length) {
    lines.push("", "Rincian hari ini:");
    for (const e of hariIni) {
      lines.push(`• ${fmtRp(e.amount)} — ${e.note}${e.src === "foto" ? " 🧾" : ""}`);
    }
  }
  return sendMessage(env, chatId, lines.join("\n"));
}

async function sendTotal(env, chatId, uid) {
  const list = await getEntries(env, uid);
  const total = list.reduce((s, e) => s + e.amount, 0);
  return sendMessage(env, chatId, `Total sepanjang waktu: ${fmtRp(total)} (${list.length} catatan)`);
}

async function deleteLast(env, chatId, uid) {
  const list = await getEntries(env, uid);
  if (!list.length) return sendMessage(env, chatId, "Tidak ada catatan untuk dihapus.");
  const last = list.pop();
  await saveEntries(env, uid, list);
  return sendMessage(env, chatId, `🗑️ Dihapus: ${fmtRp(last.amount)} — ${last.note}`);
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function helpText() {
  return [
    "🧾 Bot Catatan Pengeluaran",
    "",
    "Catat manual:",
    "• 50rb makan siang",
    "• 12000 parkir",
    "• 1,5jt sewa kos",
    "",
    "Foto struk: kirim fotonya, nanti totalnya dibaca otomatis.",
    "",
    "Perintah:",
    "/laporan — rekap hari ini & bulan ini",
    "/total — total sepanjang waktu",
    "/hapus — hapus catatan terakhir",
  ].join("\n");
}

// Ubah teks jadi { amount, note }. Mendukung rb/ribu/k, jt/juta, dan pemisah ribuan.
function parseEntry(text) {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(jt|juta|rb|ribu|k)?/i);
  if (!m) return null;
  const suf = (m[2] || "").toLowerCase();
  let amount;
  if (suf === "jt" || suf === "juta") {
    amount = parseFloat(m[1].replace(",", ".")) * 1e6;
  } else if (suf === "rb" || suf === "ribu" || suf === "k") {
    amount = parseFloat(m[1].replace(",", ".")) * 1e3;
  } else {
    amount = parseInt(m[1].replace(/[.,]/g, ""), 10); // buang pemisah ribuan
  }
  if (!isFinite(amount) || amount <= 0) return null;

  const note = text.replace(m[0], "").trim() || "(tanpa keterangan)";
  return { amount: Math.round(amount), note };
}

// Pecah timestamp jadi tahun/bulan/tanggal menurut WIB.
function wibParts(ts) {
  const d = new Date(ts + WIB_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function fmtRp(n) {
  if (n == null || !isFinite(n)) return "Rp?";
  return "Rp" + Math.round(n).toLocaleString("id-ID");
}

function isAllowed(env, fromId, chatId) {
  const raw = (env.ALLOWED_IDS || "").trim();
  if (!raw) return true; // kosong = terbuka untuk semua
  const allow = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return allow.includes(String(fromId)) || allow.includes(String(chatId));
}

async function sendMessage(env, chatId, text) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN belum diset");
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}
