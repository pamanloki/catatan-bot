// Bot catatan keuangan untuk Telegram (Cloudflare Worker).
//
// Cara pakai (kirim ke bot):
//   Pengeluaran : "50rb makan siang"  /  "12000 parkir"
//   Pemasukan   : "+5jt gaji"  (awali dengan tanda +)
//   Foto struk  : kirim foto struk -> total & toko dibaca AI (jadi pengeluaran)
//   Hutang (aku pinjam ke orang)     : /hutang 100rb budi beli bensin
//   Piutang (orang pinjam ke aku)    : /piutang 50rb ani
//   Lihat & lunasi hutang/piutang    : /lunas          (lihat daftar)
//                                      /lunas 2         (lunasi nomor 2)
//   Laporan     : /laporan
//   Total       : /total
//   Export CSV  : /export
//   Hapus akhir : /hapus
//   Bantuan     : /start, /help
//
// Siapkan di dashboard Cloudflare Worker:
//   Secrets: BOT_TOKEN (wajib), TELEGRAM_SECRET (disarankan), ALLOWED_IDS (privat)
//            GEMINI_API_KEY (opsional, baca struk jauh lebih akurat drpd Workers AI)
//   Bindings: KV Namespace -> "EXPENSES" ; Workers AI -> "AI" (cadangan struk)

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Jakarta (UTC+7)
const AI_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export default {
  async fetch(request, env) {
    if (request.method === "POST") return handleTelegram(request, env);
    return new Response("Bot catatan keuangan aktif.", {
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

async function routeMessage(env, chatId, msg) {
  const uid = msg.from.id;

  // Foto struk?
  if (Array.isArray(msg.photo) && msg.photo.length) {
    return handleReceiptPhoto(env, chatId, msg);
  }

  const text = (msg.text || "").trim();
  if (!text) return sendMessage(env, chatId, "Kirim catatan (mis. '50rb makan') atau foto struk.");

  const lower = text.toLowerCase();
  if (lower === "/start" || lower === "/help") return sendMessage(env, chatId, helpText());
  if (lower.startsWith("/laporan")) return sendReport(env, chatId, uid);
  if (lower.startsWith("/total")) return sendTotal(env, chatId, uid);
  if (lower.startsWith("/export")) return exportCsv(env, chatId, uid);
  if (lower.startsWith("/hapus")) return deleteLast(env, chatId, uid);
  if (lower.startsWith("/budget")) return handleBudget(env, chatId, uid, text.slice(7).trim());
  if (lower.startsWith("/lunas")) return handleLunas(env, chatId, uid, text.slice(6).trim());
  if (lower.startsWith("/hutang")) return handleDebt(env, chatId, uid, "hutang", text.slice(7).trim());
  if (lower.startsWith("/piutang")) return handleDebt(env, chatId, uid, "piutang", text.slice(8).trim());

  // Selain perintah -> catatan arus kas (pengeluaran / pemasukan).
  const flow = parseFlow(text);
  if (!flow) {
    return sendMessage(
      env,
      chatId,
      "Format belum kebaca.\nPengeluaran: '50rb makan'\nPemasukan: '+5jt gaji'",
    );
  }
  const { category, note } = resolveCategory(flow.note);
  await addEntry(env, uid, { kind: flow.kind, amount: flow.amount, note, category, src: "teks" });
  const label = flow.kind === "masuk" ? "Pemasukan" : "Pengeluaran";
  const icon = flow.kind === "masuk" ? "🟢" : "🔴";
  if (flow.kind === "masuk") {
    return sendMessage(env, chatId, `${icon} ${label} tercatat: ${fmtRp(flow.amount)} — ${note}`);
  }
  const extra = await spendingSummaryLines(env, uid);
  return sendMessage(
    env,
    chatId,
    [`${icon} ${label} tercatat: ${fmtRp(flow.amount)} — ${note} [${category}]`, ...extra].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Foto struk (Gemini kalau ada GEMINI_API_KEY, jika tidak Workers AI)
// ---------------------------------------------------------------------------

const RECEIPT_PROMPT =
  "Ini foto struk belanja Indonesia. Baca dengan teliti. " +
  "Ambil TOTAL akhir yang benar-benar dibayar — cari baris berlabel " +
  "TOTAL, GRAND TOTAL, TOTAL BAYAR, TOTAL BELANJA, atau TUNAI/BAYAR. " +
  "Jangan tertukar dengan subtotal, kembalian, atau pajak. " +
  "Kalau ada baris 'Netto' atau 'Total', pakai nilai itu. " +
  "Ambil juga nama toko/merchant (biasanya di bagian paling atas struk). " +
  "total = hanya digit tanpa titik/koma (mis. 209875). " +
  "Meski foto agak terpotong/buram, tetap beri tebakan angka terbaikmu; jangan menolak.";

async function handleReceiptPhoto(env, chatId, msg) {
  if (!env.AI && !env.GEMINI_API_KEY) {
    return sendMessage(env, chatId, "Fitur foto struk belum aktif (binding Workers AI 'AI' atau GEMINI_API_KEY belum diset).");
  }
  await sendMessage(env, chatId, "📸 Membaca struk...");

  const photo = msg.photo[msg.photo.length - 1]; // ukuran terbesar
  const bytes = await getTelegramFile(env, photo.file_id);

  const result = await readReceipt(env, bytes);
  if (!result || !result.amount) {
    const why = result && result.debug ? `\n\n(debug: ${result.debug})` : "";
    return sendMessage(
      env,
      chatId,
      "Maaf, total di struk tidak terbaca. Coba foto lebih jelas & lurus, atau ketik manual (mis. '50rb belanja')." + why,
    );
  }

  const note = result.toko || (msg.caption || "").trim() || "struk";
  const category = categorize(note);
  await addEntry(env, msg.from.id, { kind: "keluar", amount: result.amount, note, category, src: "foto" });
  const extra = await spendingSummaryLines(env, msg.from.id);
  return sendMessage(
    env,
    chatId,
    [`🔴 Pengeluaran (struk): ${fmtRp(result.amount)} — ${note} [${category}]`, ...extra].join("\n"),
  );
}

// Pilih mesin OCR: Gemini (akurat) kalau key ada, kalau tidak Workers AI.
async function readReceipt(env, arrayBuffer) {
  if (env.GEMINI_API_KEY) {
    const g = await readReceiptGemini(env, arrayBuffer);
    if (g && g.amount) return g;
    // kalau Gemini gagal & Workers AI tersedia, coba cadangan
    if (env.AI) {
      const w = await readReceiptWorkersAI(env, arrayBuffer);
      if (w && w.amount) return w;
    }
    return g; // bawa info debug dari Gemini
  }
  return readReceiptWorkersAI(env, arrayBuffer);
}

async function readReceiptGemini(env, arrayBuffer) {
  const model = (env.GEMINI_MODEL || "gemini-3.6-flash").trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    contents: [
      {
        parts: [
          { text: RECEIPT_PROMPT },
          { inline_data: { mime_type: "image/jpeg", data: abToBase64(arrayBuffer) } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2048, // beri ruang; model baru pakai token utk "berpikir"
      responseMimeType: "application/json", // paksa balasan JSON, bukan kalimat
      responseSchema: {
        type: "object",
        properties: {
          total: { type: "integer" },
          toko: { type: "string" },
        },
        required: ["total", "toko"],
      },
    },
  };
  let status = 0;
  let bodyText = "";
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    status = r.status;
    bodyText = await r.text();
  } catch (e) {
    return { amount: 0, toko: "", debug: `Gemini gagal konek: ${e && e.message ? e.message : e}` };
  }

  let j;
  try {
    j = JSON.parse(bodyText);
  } catch {
    return { amount: 0, toko: "", debug: `Gemini HTTP ${status}: ${bodyText.slice(0, 160)}` };
  }

  if (status !== 200 || j.error) {
    const msg = (j.error && j.error.message) || `HTTP ${status}`;
    return { amount: 0, toko: "", debug: `Gemini: ${msg}` };
  }

  const cand = j.candidates && j.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  const text = (parts || []).map((p) => p.text || "").join("");
  const parsed = parseReceiptJson(text);
  if (parsed && parsed.amount) return parsed;
  const fr = cand && cand.finishReason ? ` [${cand.finishReason}]` : "";
  return { amount: 0, toko: "", debug: `Gemini balas tapi total tak terbaca${fr}: ${text.slice(0, 120)}` };
}

async function readReceiptWorkersAI(env, arrayBuffer) {
  let out;
  try {
    out = await env.AI.run(AI_VISION_MODEL, {
      image: [...new Uint8Array(arrayBuffer)],
      prompt: RECEIPT_PROMPT,
      max_tokens: 256,
    });
  } catch {
    return null;
  }
  return parseReceiptJson((out && (out.response || out.description || "")) + "");
}

// Ekstrak {total, toko} dari teks balasan AI.
function parseReceiptJson(text) {
  const m = (text || "").match(/\{[\s\S]*\}/);
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

// ArrayBuffer -> base64 (untuk kirim gambar ke Gemini).
function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

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
// Hutang / Piutang
// ---------------------------------------------------------------------------

// /hutang 100rb budi beli bensin   -> kalau ada argumen: tambah
// /hutang                          -> kalau kosong: tampilkan daftar terbuka
async function handleDebt(env, chatId, uid, kind, args) {
  if (!args) return listOpenDebts(env, chatId, uid, kind);

  const p = parseAmountToken(args);
  if (!p) return sendMessage(env, chatId, `Format: /${kind} 100rb <nama> [keterangan]`);
  const parts = p.rest.split(/\s+/).filter(Boolean);
  const party = parts.shift() || "-";
  const note = parts.join(" ") || "(tanpa keterangan)";

  await addEntry(env, uid, { kind, amount: p.amount, note, party, status: "belum", src: "teks" });
  const label =
    kind === "hutang"
      ? `📕 Hutang dicatat: kamu pinjam ${fmtRp(p.amount)} ke ${party}`
      : `📗 Piutang dicatat: ${party} pinjam ${fmtRp(p.amount)} ke kamu`;
  return sendMessage(env, chatId, `${label}${note ? ` (${note})` : ""}`);
}

async function listOpenDebts(env, chatId, uid, kind) {
  const list = await getEntries(env, uid);
  const open = list.filter((e) => e.kind === kind && e.status === "belum");
  if (!open.length) return sendMessage(env, chatId, `Tidak ada ${kind} yang belum lunas.`);

  const title = kind === "hutang" ? "📕 Hutang belum lunas" : "📗 Piutang belum lunas";
  const lines = [title, ""];
  let total = 0;
  // Nomor mengikuti urutan gabungan agar cocok dengan /lunas.
  const openAll = openDebtsOrdered(list);
  open.forEach((e) => {
    const n = openAll.findIndex((x) => x.ts === e.ts) + 1;
    total += e.amount;
    lines.push(`${n}. ${fmtRp(e.amount)} — ${e.party} (${e.note})`);
  });
  lines.push("", `Total: ${fmtRp(total)}`, "", "Lunasi dengan: /lunas <nomor>");
  return sendMessage(env, chatId, lines.join("\n"));
}

// Daftar semua hutang+piutang yang belum lunas, urut waktu (dipakai penomoran /lunas).
function openDebtsOrdered(list) {
  return list
    .filter((e) => (e.kind === "hutang" || e.kind === "piutang") && e.status === "belum")
    .sort((a, b) => a.ts - b.ts);
}

// /lunas        -> tampilkan daftar bernomor
// /lunas 2      -> tandai nomor 2 sebagai lunas
async function handleLunas(env, chatId, uid, arg) {
  const list = await getEntries(env, uid);
  const open = openDebtsOrdered(list);
  if (!open.length) return sendMessage(env, chatId, "Tidak ada hutang/piutang yang belum lunas. 🎉");

  if (!arg) {
    const lines = ["Pilih yang mau dilunasi:", ""];
    open.forEach((e, i) => {
      const tag = e.kind === "hutang" ? "📕 hutang ke" : "📗 piutang dari";
      lines.push(`${i + 1}. ${fmtRp(e.amount)} — ${tag} ${e.party} (${e.note})`);
    });
    lines.push("", "Ketik: /lunas <nomor>");
    return sendMessage(env, chatId, lines.join("\n"));
  }

  const n = parseInt(arg, 10);
  if (!n || n < 1 || n > open.length) {
    return sendMessage(env, chatId, `Nomor tidak valid. Ketik /lunas untuk lihat daftar (1–${open.length}).`);
  }
  const target = open[n - 1];
  const idx = list.findIndex((e) => e.ts === target.ts);
  list[idx].status = "lunas";
  list[idx].lunasTs = Date.now();
  await saveEntries(env, uid, list);
  const tag = target.kind === "hutang" ? "Hutang ke" : "Piutang dari";
  return sendMessage(env, chatId, `✅ Lunas: ${tag} ${target.party} ${fmtRp(target.amount)}`);
}

// ---------------------------------------------------------------------------
// Penyimpanan (Cloudflare KV)
// ---------------------------------------------------------------------------

function kvKey(uid) {
  return `exp:${uid}`;
}
function cfgKey(uid) {
  return `cfg:${uid}`;
}
async function getConfig(env, uid) {
  if (!env.EXPENSES) throw new Error("KV 'EXPENSES' belum di-bind");
  const raw = await env.EXPENSES.get(cfgKey(uid));
  return raw ? JSON.parse(raw) : { budget: 0 };
}
async function saveConfig(env, uid, cfg) {
  await env.EXPENSES.put(cfgKey(uid), JSON.stringify(cfg));
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
  list.push({
    ts: Date.now(),
    kind: entry.kind, // keluar | masuk | hutang | piutang
    amount: entry.amount,
    note: entry.note,
    category: entry.category || "",
    party: entry.party || "",
    status: entry.status || "",
    src: entry.src || "teks",
  });
  await saveEntries(env, uid, list);
}

// ---------------------------------------------------------------------------
// Laporan & export
// ---------------------------------------------------------------------------

async function sendReport(env, chatId, uid) {
  const list = await getEntries(env, uid);
  if (!list.length) return sendMessage(env, chatId, "Belum ada catatan. Kirim '50rb ...' atau '+5jt gaji' dulu.");

  const now = wibParts(Date.now());
  const todayKey = now.y * 10000 + now.m * 100 + now.d;
  const monthKey = now.y * 100 + now.m;

  let masukBulan = 0, keluarBulan = 0, masukHari = 0, keluarHari = 0;
  let hutangOpen = 0, piutangOpen = 0;
  const hariIni = [];
  const perKategori = {}; // pengeluaran bulan ini per kategori

  for (const e of list) {
    if (e.kind === "hutang" && e.status === "belum") hutangOpen += e.amount;
    if (e.kind === "piutang" && e.status === "belum") piutangOpen += e.amount;
    if (e.kind !== "masuk" && e.kind !== "keluar") continue;

    const p = wibParts(e.ts);
    if (p.y * 100 + p.m === monthKey) {
      if (e.kind === "masuk") {
        masukBulan += e.amount;
      } else {
        keluarBulan += e.amount;
        const cat = e.category || "Lainnya";
        perKategori[cat] = (perKategori[cat] || 0) + e.amount;
      }
    }
    if (p.y * 10000 + p.m * 100 + p.d === todayKey) {
      if (e.kind === "masuk") masukHari += e.amount; else keluarHari += e.amount;
      hariIni.push(e);
    }
  }

  const lines = [`📊 Laporan (${pad(now.d)}/${pad(now.m)}/${now.y})`, ""];
  lines.push("— Hari ini —");
  lines.push(`🟢 Masuk : ${fmtRp(masukHari)}`);
  lines.push(`🔴 Keluar: ${fmtRp(keluarHari)}`);
  lines.push(`💰 Selisih: ${fmtRp(masukHari - keluarHari)}`);
  lines.push("", "— Bulan ini —");
  lines.push(`🟢 Masuk : ${fmtRp(masukBulan)}`);
  lines.push(`🔴 Keluar: ${fmtRp(keluarBulan)}`);
  lines.push(`💰 Saldo : ${fmtRp(masukBulan - keluarBulan)}`);
  const kategoriUrut = Object.entries(perKategori).sort((a, b) => b[1] - a[1]);
  if (kategoriUrut.length) {
    lines.push("", "— Pengeluaran per kategori (bulan ini) —");
    for (const [cat, amt] of kategoriUrut) {
      const persen = keluarBulan ? Math.round((amt / keluarBulan) * 100) : 0;
      lines.push(`• ${cat}: ${fmtRp(amt)} (${persen}%)`);
    }
  }
  if (hutangOpen || piutangOpen) {
    lines.push("", "— Belum lunas —");
    if (hutangOpen) lines.push(`📕 Hutang : ${fmtRp(hutangOpen)}`);
    if (piutangOpen) lines.push(`📗 Piutang: ${fmtRp(piutangOpen)}`);
  }
  if (hariIni.length) {
    lines.push("", "Rincian hari ini:");
    for (const e of hariIni) {
      const icon = e.kind === "masuk" ? "🟢" : "🔴";
      lines.push(`${icon} ${fmtRp(e.amount)} — ${e.note}${e.src === "foto" ? " 🧾" : ""}`);
    }
  }
  lines.push("", "Export lengkap: /export");
  return sendMessage(env, chatId, lines.join("\n"));
}

async function sendTotal(env, chatId, uid) {
  const list = await getEntries(env, uid);
  let masuk = 0, keluar = 0;
  for (const e of list) {
    if (e.kind === "masuk") masuk += e.amount;
    if (e.kind === "keluar") keluar += e.amount;
  }
  return sendMessage(
    env,
    chatId,
    `Sepanjang waktu:\n🟢 Masuk : ${fmtRp(masuk)}\n🔴 Keluar: ${fmtRp(keluar)}\n💰 Saldo : ${fmtRp(masuk - keluar)}`,
  );
}

// Export semua catatan sebagai file CSV (buka rapi di Excel / Google Sheets).
async function exportCsv(env, chatId, uid) {
  const list = await getEntries(env, uid);
  if (!list.length) return sendMessage(env, chatId, "Belum ada catatan untuk diexport.");

  const header = ["Tanggal", "Waktu", "Jenis", "Jumlah", "Kategori", "Keterangan", "Pihak", "Status", "Sumber"];
  const rows = [header.map(csvCell).join(",")];
  for (const e of [...list].sort((a, b) => a.ts - b.ts)) {
    const d = new Date(e.ts + WIB_OFFSET_MS);
    const tgl = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
    const jam = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    rows.push(
      [tgl, jam, e.kind, e.amount, e.category || "", e.note, e.party || "", e.status || "", e.src || ""]
        .map(csvCell)
        .join(","),
    );
  }
  const csv = "﻿" + rows.join("\r\n"); // BOM biar Excel baca UTF-8 dgn benar

  const now = wibParts(Date.now());
  const fname = `laporan-${now.y}${pad(now.m)}${pad(now.d)}.csv`;
  await sendDocument(env, chatId, csv, fname, "📄 Laporan lengkap (buka di Excel / Google Sheets).");
}

function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function deleteLast(env, chatId, uid) {
  const list = await getEntries(env, uid);
  if (!list.length) return sendMessage(env, chatId, "Tidak ada catatan untuk dihapus.");
  const last = list.pop();
  await saveEntries(env, uid, list);
  return sendMessage(env, chatId, `🗑️ Dihapus: ${last.kind} ${fmtRp(last.amount)} — ${last.note}`);
}

// /budget         -> lihat budget & pemakaian
// /budget 3jt     -> set budget bulanan
// /budget off     -> matikan
async function handleBudget(env, chatId, uid, arg) {
  const cfg = await getConfig(env, uid);

  if (!arg) {
    if (!cfg.budget) return sendMessage(env, chatId, "Belum ada budget. Set dengan: /budget 3jt");
    const extra = await spendingSummaryLines(env, uid);
    return sendMessage(env, chatId, [`🎯 Budget bulanan: ${fmtRp(cfg.budget)}`, ...extra].join("\n"));
  }
  if (arg.toLowerCase() === "off" || arg === "0") {
    cfg.budget = 0;
    await saveConfig(env, uid, cfg);
    return sendMessage(env, chatId, "🎯 Budget dimatikan.");
  }
  const p = parseAmountToken(arg);
  if (!p) return sendMessage(env, chatId, "Format: /budget 3jt  (atau /budget off)");
  cfg.budget = p.amount;
  await saveConfig(env, uid, cfg);
  return sendMessage(env, chatId, `🎯 Budget bulanan diset: ${fmtRp(p.amount)}`);
}

// Ringkasan pemakaian bulan ini (+ status budget) untuk ditempel di konfirmasi.
async function spendingSummaryLines(env, uid) {
  const [list, cfg] = await Promise.all([getEntries(env, uid), getConfig(env, uid)]);
  const now = wibParts(Date.now());
  const monthKey = now.y * 100 + now.m;

  let keluar = 0;
  for (const e of list) {
    if (e.kind !== "keluar") continue;
    const p = wibParts(e.ts);
    if (p.y * 100 + p.m === monthKey) keluar += e.amount;
  }

  const lines = [`📅 Pengeluaran bulan ini: ${fmtRp(keluar)}`];
  if (cfg.budget > 0) {
    const sisa = cfg.budget - keluar;
    const persen = Math.round((keluar / cfg.budget) * 100);
    if (sisa >= 0) {
      lines.push(`🎯 Budget ${fmtRp(cfg.budget)} — sisa ${fmtRp(sisa)} (${persen}% terpakai)`);
      if (persen >= 80) lines.push("⚠️ Sudah lewat 80% budget, hati-hati.");
    } else {
      lines.push(`🚨 Budget ${fmtRp(cfg.budget)} JEBOL ${fmtRp(-sisa)} (${persen}%)`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function helpText() {
  return [
    "🧾 Bot Catatan Keuangan",
    "",
    "Pengeluaran: 50rb makan siang  (atau -50rb makan)",
    "Pemasukan  : +5jt gaji  (pakai tanda +)",
    "Foto struk : kirim fotonya (jadi pengeluaran)",
    "Kategori   : otomatis dari kata kunci; paksa dgn #tag (mis. 100rb #arisan)",
    "",
    "Hutang/Piutang:",
    "/hutang 100rb budi beli bensin  (kamu pinjam)",
    "/piutang 50rb ani               (orang pinjam ke kamu)",
    "/lunas                          (lihat & lunasi)",
    "",
    "Budget:",
    "/budget 3jt — set batas bulanan (auto-warning)",
    "/budget — lihat sisa budget",
    "",
    "Laporan & data:",
    "/laporan — rekap hari & bulan ini",
    "/total — total sepanjang waktu",
    "/export — unduh CSV",
    "/hapus — hapus catatan terakhir",
  ].join("\n");
}

// Daftar kata kunci -> kategori (untuk deteksi otomatis pengeluaran).
const CATEGORY_RULES = [
  ["Makan", ["makan", "minum", "warung", "warteg", "kopi", "cafe", "kafe", "resto", "jajan", "sarapan", "nasi", "ayam", "bakso", "mie", "gofood", "grabfood", "snack", "cemilan", "roti", "kue"]],
  ["Transport", ["grab", "gojek", "gocar", "gobike", "ojek", "ojol", "bensin", "parkir", "tol", "bus", "kereta", "krl", "mrt", "angkot", "transport", "spbu", "pertalite", "pertamax", "solar", "taksi", "taxi"]],
  ["Belanja", ["belanja", "indomaret", "alfamart", "supermarket", "market", "shopee", "tokopedia", "lazada", "baju", "sabun", "sampo", "skincare", "kosmetik"]],
  ["Tagihan", ["listrik", "pln", "pulsa", "token", "wifi", "internet", "air", "pdam", "bpjs", "tagihan", "kuota", "paket data", "indihome"]],
  ["Kesehatan", ["obat", "dokter", "apotek", "apotik", "rumah sakit", "klinik", "vitamin", "periksa", "bpjs kesehatan"]],
  ["Hiburan", ["nonton", "netflix", "spotify", "game", "film", "bioskop", "wisata", "liburan", "main"]],
  ["Rumah", ["sewa", "kos", "kontrakan", "galon", "gas", "elpiji", "perabot", "listrik rumah"]],
  ["Pendidikan", ["buku", "kursus", "spp", "sekolah", "kuliah", "les", "seminar", "pelatihan"]],
];

// Tebak kategori dari keterangan; default "Lainnya".
function categorize(note) {
  const s = (note || "").toLowerCase();
  for (const [cat, kws] of CATEGORY_RULES) {
    if (kws.some((k) => s.includes(k))) return cat;
  }
  return "Lainnya";
}

// Ambil kategori dari '#tag' bila ada (dan buang dari keterangan); kalau tidak,
// tebak otomatis dari isi keterangan.
function resolveCategory(note) {
  const m = (note || "").match(/#(\S+)/);
  if (m) {
    const cleaned = note.replace(m[0], "").replace(/\s+/g, " ").trim() || "(tanpa keterangan)";
    return { category: capitalize(m[1]), note: cleaned };
  }
  return { category: categorize(note), note };
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// Pengeluaran = default (tanpa tanda) atau diawali '-'; pemasukan diawali '+'.
function parseFlow(text) {
  let kind = "keluar";
  let t = text;
  if (t.startsWith("+")) {
    kind = "masuk";
    t = t.slice(1).trim();
  } else if (t.startsWith("-")) {
    kind = "keluar";
    t = t.slice(1).trim();
  }
  const p = parseAmountToken(t);
  if (!p) return null;
  return { kind, amount: p.amount, note: p.rest || "(tanpa keterangan)" };
}

// Ambil angka pertama (+suffix rb/jt/k) dari teks; kembalikan { amount, rest }.
function parseAmountToken(text) {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(jt|juta|rb|ribu|k)?/i);
  if (!m) return null;
  const suf = (m[2] || "").toLowerCase();
  let amount;
  if (suf === "jt" || suf === "juta") amount = parseFloat(m[1].replace(",", ".")) * 1e6;
  else if (suf === "rb" || suf === "ribu" || suf === "k") amount = parseFloat(m[1].replace(",", ".")) * 1e3;
  else amount = parseInt(m[1].replace(/[.,]/g, ""), 10);
  if (!isFinite(amount) || amount <= 0) return null;

  const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  return { amount: Math.round(amount), rest };
}

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
  if (!raw) return true;
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

async function sendDocument(env, chatId, content, filename, caption) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN belum diset");
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([content], { type: "text/csv" }), filename);
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });
}
