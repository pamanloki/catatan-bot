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

  // Dijalankan oleh Cron Trigger (mis. tiap hari 00:00 UTC = 07:00 WIB).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
};

// Rekap bulanan otomatis: setiap tanggal 1 (WIB), kirim laporan bulan lalu.
async function runScheduled(env) {
  if (!env.EXPENSES) return;
  const now = wibParts(Date.now());
  if (now.d !== 1) return; // hanya di awal bulan

  let y = now.y;
  let m = now.m - 1;
  if (m < 1) { m = 12; y -= 1; }
  const target = { y, m };

  let cursor;
  do {
    const res = await env.EXPENSES.list({ prefix: "exp:", cursor });
    for (const k of res.keys) {
      const uid = k.name.slice(4);
      try {
        const list = JSON.parse((await env.EXPENSES.get(k.name)) || "[]");
        const key = target.y * 100 + target.m;
        const ada = list.some(
          (e) => (e.kind === "masuk" || e.kind === "keluar") && wibParts(e.ts).y * 100 + wibParts(e.ts).m === key,
        );
        if (!ada) continue; // lewati user tanpa transaksi bln itu
        await sendMessage(env, uid, `📅 Rekap otomatis ${NAMA_BULAN[target.m - 1]} ${target.y}:`);
        await monthlyReport(env, uid, uid, list, target, BACK_MENU);
      } catch {
        /* lanjut user berikutnya */
      }
    }
    cursor = res.cursor;
  } while (cursor);
}

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

  // Tombol menu ditekan
  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
    return new Response("ok");
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

// Aksi saat tombol menu (inline keyboard) ditekan.
async function handleCallback(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const fromId = cq.from && cq.from.id;
  const data = cq.data || "";
  await answerCallback(env, cq.id);
  if (!chatId) return;
  if (!isAllowed(env, fromId, chatId)) return sendMessage(env, chatId, "Maaf, bot ini privat.");

  const uid = fromId;
  try {
    if (data.startsWith("lunasi:")) {
      return settleByTs(env, chatId, uid, Number(data.slice(7)), BACK_MENU);
    }
    if (data.startsWith("edit:")) return sendEditOptions(env, chatId, uid, Number(data.slice(5)));
    if (data.startsWith("ea:")) {
      await setMode(env, uid, "edit_amount:" + data.slice(3));
      return sendMessage(env, chatId, "✏️ Ketik nominal baru, contoh: 75rb", BACK_MENU);
    }
    if (data.startsWith("en:")) {
      await setMode(env, uid, "edit_note:" + data.slice(3));
      return sendMessage(env, chatId, "📝 Ketik keterangan baru:", BACK_MENU);
    }
    if (data.startsWith("del:")) return deleteByTs(env, chatId, uid, Number(data.slice(4)));
    switch (data) {
      case "menu": return sendMenu(env, chatId);
      // Submenu kategori
      case "cat_catat": return sendMessage(env, chatId, "➕ Catat transaksi:", MENU_CATAT);
      case "cat_laporan": return sendMessage(env, chatId, "📊 Laporan & data:", MENU_LAPORAN);
      case "cat_utang": return sendMessage(env, chatId, "📋 Hutang & Piutang:", MENU_UTANG);
      case "cat_budget": return sendMessage(env, chatId, "🎯 Budget:", MENU_BUDGET);
      case "cat_lain": return sendMessage(env, chatId, "🧰 Lainnya:", MENU_LAIN);
      // Aksi (hasil selalu ada tombol balik)
      case "laporan": return sendReport(env, chatId, uid, BACK_MENU);
      case "grafik": return sendChart(env, chatId, uid, BACK_MENU);
      case "cari":
        return sendMessage(env, chatId, "Ketik: /cari <kata>\nContoh: /cari grab", BACK_MENU);
      case "utang": return sendDebtReport(env, chatId, uid, BACK_MENU);
      case "total": return sendTotal(env, chatId, uid, BACK_MENU);
      case "budget": return handleBudget(env, chatId, uid, "", BACK_MENU);
      case "lunas": return handleLunas(env, chatId, uid, "", BACK_MENU);
      case "export": return exportCsv(env, chatId, uid, BACK_MENU);
      case "hari":
        return sendMessage(env, chatId, `📆 Sekarang: ${namaHariTanggal(Date.now())} (WIB)`, BACK_MENU);
      case "help": return sendMessage(env, chatId, helpText(), BACK_MENU);
      case "edit": return sendEditList(env, chatId, uid);
      case "add_keluar":
        await setMode(env, uid, "keluar");
        return sendMessage(env, chatId, "🔴 Ketik pengeluaran (langsung, tanpa perintah):\ncontoh: 50rb makan siang\n(tanggal opsional: 50rb makan tgl 15-3)", BACK_MENU);
      case "add_masuk":
        await setMode(env, uid, "masuk");
        return sendMessage(env, chatId, "🟢 Ketik pemasukan (langsung):\ncontoh: 5jt gaji", BACK_MENU);
      case "add_hutang":
        await setMode(env, uid, "hutang");
        return sendMessage(env, chatId, "📕 Ketik: nominal nama [ket] [tgl]\ncontoh: 100rb budi bensin tgl 15-3-2025", BACK_MENU);
      case "add_piutang":
        await setMode(env, uid, "piutang");
        return sendMessage(env, chatId, "📗 Ketik: nominal nama [ket] [tgl]\ncontoh: 50rb ani tgl 15-3-2025", BACK_MENU);
    }
  } catch (e) {
    return sendMessage(env, chatId, "Error: " + (e && e.message ? e.message : e));
  }
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
  if (lower === "/start") {
    await sendMessage(env, chatId, helpText());
    return sendMenu(env, chatId);
  }
  if (lower === "/help") return sendMessage(env, chatId, helpText());
  if (lower.startsWith("/menu")) return sendMenu(env, chatId);
  if (lower.startsWith("/setup")) return setupMenuButton(env, chatId);
  if (lower.startsWith("/laporan")) return sendReport(env, chatId, uid, undefined, text.slice(8).trim());
  if (lower.startsWith("/grafik") || lower.startsWith("/chart")) return sendChart(env, chatId, uid);
  if (lower.startsWith("/cari")) return handleCari(env, chatId, uid, text.slice(5).trim());
  if (lower.startsWith("/total")) return sendTotal(env, chatId, uid);
  if (lower.startsWith("/export")) return exportCsv(env, chatId, uid);
  if (lower.startsWith("/hapus")) return handleHapus(env, chatId, uid, text.slice(6).trim());
  if (lower.startsWith("/hari") || lower.startsWith("/tanggal")) return sendMessage(env, chatId, `📆 Sekarang: ${namaHariTanggal(Date.now())} (WIB)`);
  if (lower.startsWith("/budget")) return handleBudget(env, chatId, uid, text.slice(7).trim());
  if (lower.startsWith("/lunas")) return handleLunas(env, chatId, uid, text.slice(6).trim());
  if (lower.startsWith("/utang") || lower.startsWith("/rekaputang")) return sendDebtReport(env, chatId, uid);
  if (lower.startsWith("/edit")) return sendEditList(env, chatId, uid);
  if (lower.startsWith("/hutang")) return handleDebt(env, chatId, uid, "hutang", text.slice(7).trim());
  if (lower.startsWith("/piutang")) return handleDebt(env, chatId, uid, "piutang", text.slice(8).trim());

  // Kalau lagi menunggu input dari tombol (mode), proses sesuai mode itu.
  const mode = await getMode(env, uid);
  if (mode) {
    await clearMode(env, uid);
    return handleModeInput(env, chatId, uid, mode, text);
  }

  // Selain perintah -> catatan arus kas (pengeluaran / pemasukan).
  return recordFlow(env, chatId, uid, text);
}

// Catat pengeluaran/pemasukan dari teks bebas.
async function recordFlow(env, chatId, uid, text) {
  const flow = parseFlow(text);
  if (!flow) {
    return sendMessage(
      env,
      chatId,
      "Format belum kebaca.\nPengeluaran: '50rb makan'\nPemasukan: '+5jt gaji'",
    );
  }
  const tgl = parseTanggal(flow.note);
  const { category, note } = resolveCategory(tgl.rest);
  await addEntry(env, uid, { kind: flow.kind, amount: flow.amount, note, category, ts: tgl.ts || 0, src: "teks" });
  const label = flow.kind === "masuk" ? "Pemasukan" : "Pengeluaran";
  const icon = flow.kind === "masuk" ? "🟢" : "🔴";
  const tglTeks = tgl.ts ? `\n🗓️ ${namaHariTanggal(tgl.ts)}` : "";
  if (flow.kind === "masuk") {
    return sendMessage(env, chatId, `${icon} ${label} tercatat: ${fmtRp(flow.amount)} — ${note}${tglTeks}`, BACK_MENU);
  }
  const extra = await spendingSummaryLines(env, uid);
  return sendMessage(
    env,
    chatId,
    [`${icon} ${label} tercatat: ${fmtRp(flow.amount)} — ${note} [${category}]${tglTeks}`, ...extra].join("\n"),
    BACK_MENU,
  );
}

// Proses input teks setelah menekan tombol (mode aktif).
async function handleModeInput(env, chatId, uid, mode, text) {
  if (mode === "keluar") return recordFlow(env, chatId, uid, text);
  if (mode === "masuk") return recordFlow(env, chatId, uid, "+" + text.replace(/^\+/, ""));
  if (mode === "hutang") return handleDebt(env, chatId, uid, "hutang", text);
  if (mode === "piutang") return handleDebt(env, chatId, uid, "piutang", text);
  if (mode.startsWith("edit_amount:")) {
    const p = parseAmountToken(text);
    if (!p) return sendMessage(env, chatId, "Nominal tak terbaca. Contoh: 50rb", BACK_MENU);
    return editField(env, chatId, uid, Number(mode.slice(12)), "amount", p.amount);
  }
  if (mode.startsWith("edit_note:")) {
    return editField(env, chatId, uid, Number(mode.slice(10)), "note", text.trim());
  }
  // mode tak dikenal -> perlakukan sebagai catatan biasa
  return recordFlow(env, chatId, uid, text);
}

// ---------------------------------------------------------------------------
// Foto struk (Gemini kalau ada GEMINI_API_KEY, jika tidak Workers AI)
// ---------------------------------------------------------------------------

const RECEIPT_PROMPT =
  "Ini foto bukti pengeluaran dari Indonesia. Bisa berupa: struk belanja, " +
  "bukti transfer bank/m-banking, atau pembayaran e-wallet (GoPay, OVO, Dana, ShopeePay, dll). " +
  "Baca dengan teliti dan ambil JUMLAH UANG yang dibayar/ditransfer: " +
  "untuk struk cari TOTAL/GRAND TOTAL/NETTO/TUNAI (jangan subtotal/kembalian/pajak); " +
  "untuk transfer/e-wallet ambil nominal transfer / jumlah bayar. " +
  "Ambil juga 'toko' = nama toko/merchant, atau nama penerima transfer. " +
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
  // Coba beberapa kali kalau Gemini lagi ramai (high demand / 429 / 5xx).
  let status = 0;
  let bodyText = "";
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      status = r.status;
      bodyText = await r.text();
    } catch (e) {
      lastErr = `Gemini gagal konek: ${e && e.message ? e.message : e}`;
      await sleep(1200 * attempt);
      continue;
    }

    const transient =
      status === 429 || status >= 500 || /high demand|overloaded|unavailable|try again/i.test(bodyText);
    if (transient && attempt < 3) {
      lastErr = `Gemini sibuk (HTTP ${status})`;
      await sleep(1200 * attempt);
      continue;
    }
    break;
  }

  if (!bodyText) return { amount: 0, toko: "", debug: lastErr || "Gemini tidak merespons" };

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
  if (!p) return sendMessage(env, chatId, `Format: /${kind} 100rb <nama> [keterangan] [tgl 15-3-2025]`);

  // Ambil tanggal kejadian bila ditulis (tgl 15-3-2025 / tanggal 15/3).
  const tgl = parseTanggal(p.rest);
  const parts = tgl.rest.split(/\s+/).filter(Boolean);
  const party = parts.shift() || "-";
  const note = parts.join(" ") || "(tanpa keterangan)";

  await addEntry(env, uid, {
    kind, amount: p.amount, note, party, status: "belum", ts: tgl.ts || 0, src: "teks",
  });
  const label =
    kind === "hutang"
      ? `📕 Hutang dicatat: kamu pinjam ${fmtRp(p.amount)} ke ${party}`
      : `📗 Piutang dicatat: ${party} pinjam ${fmtRp(p.amount)} ke kamu`;
  const tglTeks = tgl.ts ? `\n🗓️ Tanggal: ${namaHariTanggal(tgl.ts)}` : "";
  return sendMessage(env, chatId, `${label}${note ? ` (${note})` : ""}${tglTeks}`);
}

// Ambil tanggal kejadian dari teks: "tgl 15-3-2025", "tanggal 15/3", "pada 1 1 2024".
// Kembalikan { ts, rest }. Kalau tanpa tahun -> pakai tahun sekarang.
function parseTanggal(s) {
  const m = s.match(/(?:tgl|tanggal|pada)\s*[:=]?\s*(\d{1,2})[-/ ](\d{1,2})(?:[-/ ](\d{2,4}))?/i);
  if (!m) return { ts: 0, rest: s };
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  let y = m[3] ? parseInt(m[3], 10) : wibParts(Date.now()).y;
  if (y < 100) y += 2000;
  if (!d || d > 31 || !mo || mo > 12) return { ts: 0, rest: s };
  // Tengah hari WIB pada tanggal itu (aman dari geser zona waktu).
  const ts = Date.UTC(y, mo - 1, d, 12, 0, 0) - WIB_OFFSET_MS;
  const rest = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  return { ts, rest };
}

// Tanggal singkat "15/03/2025" untuk ditampilkan di daftar.
function tglPendek(ts) {
  const p = wibParts(ts);
  return `${pad(p.d)}/${pad(p.m)}/${p.y}`;
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
    lines.push(`${n}. ${fmtRp(e.amount)} — ${e.party} (${e.note}) · ${tglPendek(e.ts)}`);
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

// Laporan gabungan hutang & piutang (yang belum lunas).
async function sendDebtReport(env, chatId, uid, markup) {
  const list = await getEntries(env, uid);
  const hutang = list.filter((e) => e.kind === "hutang" && e.status === "belum").sort((a, b) => a.ts - b.ts);
  const piutang = list.filter((e) => e.kind === "piutang" && e.status === "belum").sort((a, b) => a.ts - b.ts);

  if (!hutang.length && !piutang.length) {
    return sendMessage(env, chatId, "🎉 Tidak ada hutang/piutang yang belum lunas.", markup);
  }

  const totalH = hutang.reduce((s, e) => s + e.amount, 0);
  const totalP = piutang.reduce((s, e) => s + e.amount, 0);
  const lines = ["📊 Rekap Hutang & Piutang", ""];

  lines.push(`📕 Hutang (kamu pinjam) — ${fmtRp(totalH)}`);
  if (hutang.length) {
    for (const e of hutang) lines.push(`• ${fmtRp(e.amount)} — ${e.party} (${e.note}) · ${tglPendek(e.ts)}`);
  } else {
    lines.push("• (tidak ada)");
  }

  lines.push("", `📗 Piutang (orang pinjam) — ${fmtRp(totalP)}`);
  if (piutang.length) {
    for (const e of piutang) lines.push(`• ${fmtRp(e.amount)} — ${e.party} (${e.note}) · ${tglPendek(e.ts)}`);
  } else {
    lines.push("• (tidak ada)");
  }

  const selisih = totalP - totalH;
  const tanda = selisih >= 0 ? "surplus" : "defisit";
  lines.push("", `⚖️ Selisih (piutang − hutang): ${fmtRp(Math.abs(selisih))} ${tanda}`);
  lines.push("", "Lunasi dengan: /lunas");
  return sendMessage(env, chatId, lines.join("\n"), markup);
}

// /lunas        -> tampilkan daftar bernomor
// /lunas 2      -> tandai nomor 2 sebagai lunas
async function handleLunas(env, chatId, uid, arg, markup) {
  const list = await getEntries(env, uid);
  const open = openDebtsOrdered(list);
  if (!open.length) return sendMessage(env, chatId, "Tidak ada hutang/piutang yang belum lunas. 🎉", markup);

  if (!arg) {
    // Daftar + tombol tap untuk melunasi tiap item.
    const lines = ["Pilih yang mau dilunasi (tap tombol):", ""];
    const rows = [];
    open.forEach((e, i) => {
      const tag = e.kind === "hutang" ? "📕 hutang ke" : "📗 piutang dari";
      lines.push(`${i + 1}. ${fmtRp(e.amount)} — ${tag} ${e.party} (${e.note})`);
      rows.push([{ text: `✅ Lunasi ${i + 1} — ${e.party}`, callback_data: `lunasi:${e.ts}` }]);
    });
    rows.push([BACK_BTN]);
    return sendMessage(env, chatId, lines.join("\n"), { reply_markup: { inline_keyboard: rows } });
  }

  const n = parseInt(arg, 10);
  if (!n || n < 1 || n > open.length) {
    return sendMessage(env, chatId, `Nomor tidak valid. Ketik /lunas untuk lihat daftar (1–${open.length}).`, markup);
  }
  return settleByTs(env, chatId, uid, open[n - 1].ts, markup);
}

// Tandai satu hutang/piutang (berdasarkan ts) sebagai lunas.
async function settleByTs(env, chatId, uid, ts, markup) {
  const list = await getEntries(env, uid);
  const idx = list.findIndex((e) => e.ts === ts && e.status === "belum");
  if (idx === -1) return sendMessage(env, chatId, "Item sudah tidak ada / sudah lunas.", markup);
  list[idx].status = "lunas";
  list[idx].lunasTs = Date.now();
  await saveEntries(env, uid, list);
  const t = list[idx];
  const tag = t.kind === "hutang" ? "Hutang ke" : "Piutang dari";
  return sendMessage(env, chatId, `✅ Lunas: ${tag} ${t.party} ${fmtRp(t.amount)}`, markup);
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
// "Mode" = ingatan sesaat: setelah tap tombol +, pesan teks berikutnya diproses
// sesuai mode ini. Auto-hilang setelah 15 menit.
function modeKey(uid) {
  return `mode:${uid}`;
}
async function setMode(env, uid, val) {
  await env.EXPENSES.put(modeKey(uid), val, { expirationTtl: 900 });
}
async function getMode(env, uid) {
  return (await env.EXPENSES.get(modeKey(uid))) || "";
}
async function clearMode(env, uid) {
  await env.EXPENSES.delete(modeKey(uid));
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
    ts: entry.ts || Date.now(), // bisa di-backdate (mis. hutang tahun lalu)
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

async function sendReport(env, chatId, uid, markup, arg) {
  const list = await getEntries(env, uid);
  if (!list.length) return sendMessage(env, chatId, "Belum ada catatan. Kirim '50rb ...' atau '+5jt gaji' dulu.", markup);

  // /laporan <bulan> -> laporan bulan tertentu
  const target = arg ? parseMonthArg(arg) : null;
  if (arg && !target) {
    return sendMessage(env, chatId, "Bulan tidak dikenali. Contoh: /laporan agustus  atau  /laporan 2026-08", markup);
  }
  if (target) return monthlyReport(env, chatId, uid, list, target, markup);

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

  const lines = [`📊 Laporan`, `🗓️ ${namaHariTanggal(Date.now())}`, ""];
  lines.push("— Hari ini —");
  lines.push(`🟢 Masuk : ${fmtRp(masukHari)}`);
  lines.push(`🔴 Keluar: ${fmtRp(keluarHari)}`);
  lines.push(`💰 Selisih: ${fmtRp(masukHari - keluarHari)}`);
  lines.push("", `— ${namaBulan(now)} —`);
  lines.push(`🟢 Masuk : ${fmtRp(masukBulan)}`);
  lines.push(`🔴 Keluar: ${fmtRp(keluarBulan)}`);
  lines.push(`💰 Saldo : ${fmtRp(masukBulan - keluarBulan)}`);
  const kategoriUrut = Object.entries(perKategori).sort((a, b) => b[1] - a[1]);
  if (kategoriUrut.length) {
    lines.push("", `— Pengeluaran per kategori (${namaBulan(now)}) —`);
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
  return sendMessage(env, chatId, lines.join("\n"), markup);
}

// Laporan untuk bulan tertentu (dipakai /laporan <bulan>).
async function monthlyReport(env, chatId, uid, list, target, markup) {
  const key = target.y * 100 + target.m;
  let masuk = 0, keluar = 0;
  const perKategori = {};
  for (const e of list) {
    if (e.kind !== "masuk" && e.kind !== "keluar") continue;
    const p = wibParts(e.ts);
    if (p.y * 100 + p.m !== key) continue;
    if (e.kind === "masuk") masuk += e.amount;
    else {
      keluar += e.amount;
      const cat = e.category || "Lainnya";
      perKategori[cat] = (perKategori[cat] || 0) + e.amount;
    }
  }
  const lines = [`📊 Laporan — ${NAMA_BULAN[target.m - 1]} ${target.y}`, ""];
  lines.push(`🟢 Masuk : ${fmtRp(masuk)}`);
  lines.push(`🔴 Keluar: ${fmtRp(keluar)}`);
  lines.push(`💰 Saldo : ${fmtRp(masuk - keluar)}`);
  const urut = Object.entries(perKategori).sort((a, b) => b[1] - a[1]);
  if (urut.length) {
    lines.push("", "— Per kategori —");
    for (const [cat, amt] of urut) {
      const persen = keluar ? Math.round((amt / keluar) * 100) : 0;
      lines.push(`• ${cat}: ${fmtRp(amt)} (${persen}%)`);
    }
  } else {
    lines.push("", "(tidak ada transaksi bulan ini)");
  }
  return sendMessage(env, chatId, lines.join("\n"), markup);
}

// Parse argumen bulan: nama ("agustus"), angka ("8"), atau "2026-08".
function parseMonthArg(arg) {
  const s = arg.trim().toLowerCase();
  const now = wibParts(Date.now());
  let m2 = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m2) return { y: parseInt(m2[1], 10), m: parseInt(m2[2], 10) };
  const idx = NAMA_BULAN.findIndex((b) => b.toLowerCase() === s);
  if (idx >= 0) return { y: now.y, m: idx + 1 };
  if (/^\d{1,2}$/.test(s)) {
    const m = parseInt(s, 10);
    if (m >= 1 && m <= 12) return { y: now.y, m };
  }
  return null;
}

// Grafik pai pengeluaran per kategori (bulan ini) via QuickChart.
async function sendChart(env, chatId, uid, markup) {
  const list = await getEntries(env, uid);
  const now = wibParts(Date.now());
  const key = now.y * 100 + now.m;
  const perKategori = {};
  for (const e of list) {
    if (e.kind !== "keluar") continue;
    const p = wibParts(e.ts);
    if (p.y * 100 + p.m !== key) continue;
    const cat = e.category || "Lainnya";
    perKategori[cat] = (perKategori[cat] || 0) + e.amount;
  }
  const entries = Object.entries(perKategori).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    return sendMessage(env, chatId, "Belum ada pengeluaran bulan ini untuk digambar.", markup || BACK_MENU);
  }
  const labels = entries.map((e) => e[0]);
  const data = entries.map((e) => e[1]);
  const config = {
    type: "outlabeledPie",
    data: {
      labels,
      datasets: [{ data, backgroundColor: ["#4e79a7","#f28e2b","#e15759","#76b7b2","#59a14f","#edc948","#b07aa1","#9c755f","#bab0ac"] }],
    },
    options: { plugins: { legend: { position: "bottom" }, outlabels: { text: "%l %p", stretch: 12 } } },
  };
  const url = "https://quickchart.io/chart?w=500&h=360&c=" + encodeURIComponent(JSON.stringify(config));
  const total = data.reduce((s, x) => s + x, 0);
  await sendPhoto(env, chatId, url, `📊 Pengeluaran ${namaBulan(now)} — total ${fmtRp(total)}`, markup || BACK_MENU);
}

// Cari transaksi berisi kata kunci.
async function handleCari(env, chatId, uid, kw, markup) {
  if (!kw) return sendMessage(env, chatId, "Ketik kata yang dicari, mis: /cari grab", markup);
  const list = await getEntries(env, uid);
  const q = kw.toLowerCase();
  const hit = list.filter(
    (e) =>
      (e.note || "").toLowerCase().includes(q) ||
      (e.party || "").toLowerCase().includes(q) ||
      (e.category || "").toLowerCase().includes(q),
  );
  if (!hit.length) return sendMessage(env, chatId, `Tidak ada catatan mengandung "${kw}".`, markup);

  hit.sort((a, b) => b.ts - a.ts);
  const lines = [`🔍 Hasil "${kw}" (${hit.length}):`, ""];
  let total = 0;
  for (const e of hit.slice(0, 30)) {
    const icon = e.kind === "masuk" ? "🟢" : e.kind === "keluar" ? "🔴" : "📘";
    if (e.kind === "keluar") total += e.amount;
    lines.push(`${icon} ${tglPendek(e.ts)} — ${fmtRp(e.amount)} — ${e.note}${e.party ? " / " + e.party : ""}`);
  }
  if (hit.length > 30) lines.push(`… dan ${hit.length - 30} lagi`);
  lines.push("", `Total pengeluaran cocok: ${fmtRp(total)}`);
  return sendMessage(env, chatId, lines.join("\n"), markup);
}

async function sendTotal(env, chatId, uid, markup) {
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
    markup,
  );
}

// Export semua catatan sebagai file CSV (buka rapi di Excel / Google Sheets).
async function exportCsv(env, chatId, uid, markup) {
  const list = await getEntries(env, uid);
  if (!list.length) return sendMessage(env, chatId, "Belum ada catatan untuk diexport.", markup);

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
  if (markup) await sendMessage(env, chatId, "Selesai. 👇", markup);
}

function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// /hapus       -> hapus catatan terakhir
// /hapus all   -> hapus SEMUA catatan (setelah konfirmasi)
async function handleHapus(env, chatId, uid, arg) {
  const a = arg.toLowerCase();
  if (a === "all" || a === "semua") return confirmHapusAll(env, chatId, uid);
  if (a === "all!" || a === "semua!" || a === "ya") return doHapusAll(env, chatId, uid);
  return deleteLast(env, chatId, uid);
}

async function confirmHapusAll(env, chatId, uid) {
  const list = await getEntries(env, uid);
  if (!list.length) return sendMessage(env, chatId, "Tidak ada catatan untuk dihapus.");
  return sendMessage(
    env,
    chatId,
    `⚠️ Yakin hapus SEMUA ${list.length} catatan? Ini tidak bisa dibatalkan.\n` +
      "Backup dulu dengan /export.\n\nKetik tepat: /hapusall!  (pakai tanda seru) untuk lanjut.",
  );
}

async function doHapusAll(env, chatId, uid) {
  const list = await getEntries(env, uid);
  const n = list.length;
  await saveEntries(env, uid, []);
  return sendMessage(env, chatId, `🗑️ Semua catatan dihapus (${n} entri).`);
}

async function deleteLast(env, chatId, uid) {
  const list = await getEntries(env, uid);
  if (!list.length) return sendMessage(env, chatId, "Tidak ada catatan untuk dihapus.");
  const last = list.pop();
  await saveEntries(env, uid, list);
  return sendMessage(env, chatId, `🗑️ Dihapus: ${last.kind} ${fmtRp(last.amount)} — ${last.note}`);
}

// ---------------------------------------------------------------------------
// Edit catatan (pilih dari daftar, lalu ubah/hapus)
// ---------------------------------------------------------------------------

function entryIcon(e) {
  return e.kind === "masuk" ? "🟢" : e.kind === "keluar" ? "🔴" : e.kind === "hutang" ? "📕" : "📗";
}

// Daftar catatan terbaru sebagai tombol untuk diedit.
async function sendEditList(env, chatId, uid) {
  const list = await getEntries(env, uid);
  if (!list.length) return sendMessage(env, chatId, "Belum ada catatan.", BACK_MENU);
  const recent = [...list].sort((a, b) => b.ts - a.ts).slice(0, 10);
  const rows = recent.map((e) => {
    const ket = (e.note || e.party || "").slice(0, 22);
    return [{ text: `${entryIcon(e)} ${fmtRp(e.amount)} — ${ket}`, callback_data: `edit:${e.ts}` }];
  });
  rows.push([BACK_BTN]);
  return sendMessage(env, chatId, "✏️ Pilih catatan yang mau diedit:", { reply_markup: { inline_keyboard: rows } });
}

// Pilihan aksi untuk satu catatan.
async function sendEditOptions(env, chatId, uid, ts) {
  const list = await getEntries(env, uid);
  const e = list.find((x) => x.ts === ts);
  if (!e) return sendMessage(env, chatId, "Catatan tidak ditemukan (mungkin sudah dihapus).", BACK_MENU);
  const info = `${entryIcon(e)} ${fmtRp(e.amount)} — ${e.note}${e.party ? " / " + e.party : ""}\n🗓️ ${tglPendek(e.ts)}`;
  const rows = [
    [
      { text: "✏️ Nominal", callback_data: `ea:${ts}` },
      { text: "📝 Keterangan", callback_data: `en:${ts}` },
    ],
    [{ text: "🗑️ Hapus", callback_data: `del:${ts}` }],
    [{ text: "🔙 Daftar", callback_data: "edit" }, BACK_BTN],
  ];
  return sendMessage(env, chatId, `Edit:\n${info}`, { reply_markup: { inline_keyboard: rows } });
}

// Ubah satu field (amount / note) sebuah catatan.
async function editField(env, chatId, uid, ts, field, value) {
  const list = await getEntries(env, uid);
  const idx = list.findIndex((x) => x.ts === ts);
  if (idx === -1) return sendMessage(env, chatId, "Catatan tidak ditemukan.", BACK_MENU);
  list[idx][field] = value;
  // kalau keterangan diubah, kategori otomatis ikut menyesuaikan (kecuali pakai #tag)
  if (field === "note" && (list[idx].kind === "keluar" || list[idx].kind === "masuk")) {
    const r = resolveCategory(value);
    list[idx].note = r.note;
    list[idx].category = r.category;
  }
  await saveEntries(env, uid, list);
  const e = list[idx];
  return sendMessage(
    env,
    chatId,
    `✅ Diperbarui:\n${entryIcon(e)} ${fmtRp(e.amount)} — ${e.note}${e.party ? " / " + e.party : ""}`,
    BACK_MENU,
  );
}

// Hapus satu catatan berdasarkan ts.
async function deleteByTs(env, chatId, uid, ts) {
  const list = await getEntries(env, uid);
  const idx = list.findIndex((x) => x.ts === ts);
  if (idx === -1) return sendMessage(env, chatId, "Catatan tidak ditemukan.", BACK_MENU);
  const e = list.splice(idx, 1)[0];
  await saveEntries(env, uid, list);
  return sendMessage(env, chatId, `🗑️ Dihapus: ${entryIcon(e)} ${fmtRp(e.amount)} — ${e.note}`, BACK_MENU);
}

// /budget         -> lihat budget & pemakaian
// /budget 3jt     -> set budget bulanan
// /budget off     -> matikan
async function handleBudget(env, chatId, uid, arg, markup) {
  const cfg = await getConfig(env, uid);

  if (!arg) {
    if (!cfg.budget) return sendMessage(env, chatId, "Belum ada budget. Set dengan: /budget 3jt", markup);
    const extra = await spendingSummaryLines(env, uid);
    return sendMessage(env, chatId, [`🎯 Budget bulanan: ${fmtRp(cfg.budget)}`, ...extra].join("\n"), markup);
  }
  if (arg.toLowerCase() === "off" || arg === "0") {
    cfg.budget = 0;
    await saveConfig(env, uid, cfg);
    return sendMessage(env, chatId, "🎯 Budget dimatikan.", markup);
  }
  const p = parseAmountToken(arg);
  if (!p) return sendMessage(env, chatId, "Format: /budget 3jt  (atau /budget off)", markup);
  cfg.budget = p.amount;
  await saveConfig(env, uid, cfg);
  return sendMessage(env, chatId, `🎯 Budget bulanan diset: ${fmtRp(p.amount)}`, markup);
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
    "Kategori   : otomatis; paksa dgn #tag (mis. 100rb #arisan)",
    "Tanggal    : tambah 'tgl 15-3-2025' utk backdate",
    "",
    "Hutang/Piutang:",
    "/hutang 100rb budi bensin tgl 15-3-2025  (kamu pinjam)",
    "/piutang 50rb ani                        (orang pinjam ke kamu)",
    "/utang                                   (rekap)",
    "/lunas                                   (lihat & lunasi)",
    "",
    "Budget:",
    "/budget 3jt — set batas bulanan (auto-warning)",
    "/budget — lihat sisa budget",
    "",
    "Laporan & data:",
    "/laporan — rekap hari & bulan ini",
    "/laporan agustus — laporan bulan tertentu",
    "/grafik — grafik pai per kategori",
    "/cari grab — cari transaksi",
    "/total — total sepanjang waktu",
    "/export — unduh CSV",
    "/hari — tanggal & hari sekarang",
    "/edit — pilih catatan utk ubah/hapus",
    "/hapus — hapus catatan terakhir",
    "/hapusall — hapus semua (perlu konfirmasi)",
    "",
    "Tekan /menu untuk tombol cepat (tap tombol -> langsung ketik angkanya).",
  ].join("\n");
}

// Tombol balik ke menu utama (ditempel di tiap hasil).
const BACK_BTN = { text: "🔙 Menu", callback_data: "menu" };
const BACK_MENU = { reply_markup: { inline_keyboard: [[BACK_BTN]] } };

// Menu utama: pilih kategori dulu.
const MENU_MAIN = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "➕ Catat", callback_data: "cat_catat" },
        { text: "📊 Laporan", callback_data: "cat_laporan" },
      ],
      [
        { text: "📋 Hutang/Piutang", callback_data: "cat_utang" },
        { text: "🎯 Budget", callback_data: "cat_budget" },
      ],
      [
        { text: "🧰 Lainnya", callback_data: "cat_lain" },
        { text: "❓ Bantuan", callback_data: "help" },
      ],
    ],
  },
};

// Submenu per kategori (masing-masing ada tombol balik).
const MENU_CATAT = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "🔴 + Keluar", callback_data: "add_keluar" },
        { text: "🟢 + Masuk", callback_data: "add_masuk" },
      ],
      [BACK_BTN],
    ],
  },
};
const MENU_LAPORAN = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "📊 Laporan", callback_data: "laporan" },
        { text: "📈 Grafik", callback_data: "grafik" },
      ],
      [
        { text: "💰 Total", callback_data: "total" },
        { text: "📄 Export CSV", callback_data: "export" },
      ],
      [
        { text: "🔍 Cari", callback_data: "cari" },
        { text: "📆 Hari ini", callback_data: "hari" },
      ],
      [BACK_BTN],
    ],
  },
};
const MENU_UTANG = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "📋 Rekap", callback_data: "utang" },
        { text: "✅ Lunas", callback_data: "lunas" },
      ],
      [
        { text: "📕 + Hutang", callback_data: "add_hutang" },
        { text: "📗 + Piutang", callback_data: "add_piutang" },
      ],
      [BACK_BTN],
    ],
  },
};
const MENU_BUDGET = {
  reply_markup: {
    inline_keyboard: [[{ text: "🎯 Lihat budget", callback_data: "budget" }], [BACK_BTN]],
  },
};
const MENU_LAIN = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "✏️ Edit catatan", callback_data: "edit" },
        { text: "📄 Export CSV", callback_data: "export" },
      ],
      [
        { text: "📆 Hari ini", callback_data: "hari" },
        { text: "❓ Bantuan", callback_data: "help" },
      ],
      [BACK_BTN],
    ],
  },
};

async function sendMenu(env, chatId) {
  return sendMessage(env, chatId, "📱 Menu — pilih kategori:", MENU_MAIN);
}

async function answerCallback(env, callbackId) {
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId }),
    });
  } catch {
    /* abaikan */
  }
}

// Daftarkan daftar perintah -> muncul di tombol "Menu" biru Telegram.
async function setupMenuButton(env, chatId) {
  const commands = [
    { command: "menu", description: "Tombol cepat" },
    { command: "laporan", description: "Rekap hari & bulan ini" },
    { command: "utang", description: "Rekap hutang & piutang" },
    { command: "lunas", description: "Lihat & lunasi hutang/piutang" },
    { command: "budget", description: "Lihat/atur budget bulanan" },
    { command: "total", description: "Total sepanjang waktu" },
    { command: "export", description: "Unduh CSV" },
    { command: "hari", description: "Tanggal & hari sekarang" },
    { command: "hapus", description: "Hapus catatan terakhir" },
    { command: "help", description: "Bantuan" },
  ];
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands }),
    });
    return sendMessage(env, chatId, "✅ Tombol Menu Telegram sudah diatur. Cek ikon menu di kiri kotak ketik.");
  } catch (e) {
    return sendMessage(env, chatId, "Gagal mengatur menu: " + (e && e.message ? e.message : e));
  }
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

const NAMA_BULAN = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];
const NAMA_HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

function wibParts(ts) {
  const d = new Date(ts + WIB_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() };
}

// "Jumat, 20 September 2026"
function namaHariTanggal(ts) {
  const p = wibParts(ts);
  return `${NAMA_HARI[p.dow]}, ${p.d} ${NAMA_BULAN[p.m - 1]} ${p.y}`;
}

// "September 2026"
function namaBulan(p) {
  return `${NAMA_BULAN[p.m - 1]} ${p.y}`;
}
function pad(n) {
  return String(n).padStart(2, "0");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function sendMessage(env, chatId, text, extra) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN belum diset");
  const payload = { chat_id: chatId, text, disable_web_page_preview: true, ...(extra || {}) };
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function sendPhoto(env, chatId, photoUrl, caption, extra) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN belum diset");
  const payload = { chat_id: chatId, photo: photoUrl, caption, ...(extra || {}) };
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  // Kalau gagal kirim gambar (mis. URL terlalu panjang), beri tahu.
  if (!r.ok) await sendMessage(env, chatId, "Gagal membuat grafik. Coba lagi nanti.", extra);
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
