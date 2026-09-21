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
const NO_WALLET = "Tanpa dompet"; // penanda transaksi yang tak menyentuh saldo dompet
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
    if (data.startsWith("ewp:")) return sendEntryWalletPicker(env, chatId, uid, Number(data.slice(4)));
    if (data.startsWith("ew:")) { const [, ts, i] = data.split(":"); return setEntryWallet(env, chatId, uid, Number(ts), Number(i)); }
    if (data.startsWith("del:")) return deleteByTs(env, chatId, uid, Number(data.slice(4)));
    if (data === "dorestore") return doRestore(env, chatId, uid);
    if (data === "ai_on") return handleAi(env, chatId, uid, "on");
    if (data === "ai_off") return handleAi(env, chatId, uid, "off");
    if (data === "del_last") return deleteLast(env, chatId, uid, BACK_MENU);
    if (data === "del_all") {
      return sendMessage(env, chatId, "⚠️ Hapus SEMUA catatan? Tidak bisa dibatalkan.\nSaran: /backup dulu.", {
        reply_markup: { inline_keyboard: [[{ text: "✅ Ya, hapus semua", callback_data: "del_all_yes" }], [{ text: "Batal", callback_data: "menu" }]] },
      });
    }
    if (data === "del_all_yes") return doHapusAll(env, chatId, uid, BACK_MENU);
    if (data === "impor") return handleImportStart(env, chatId, uid);
    if (data === "doimport") return doImport(env, chatId, uid);

    // --- Alur berbasis tombol (biar minim ngetik) ---
    // Pindah antar dompet: dari -> ke -> nominal
    if (data.startsWith("pf:")) return wPindahTo(env, chatId, uid, Number(data.slice(3)));
    if (data.startsWith("pt:")) { const [, i, j] = data.split(":"); return wPindahNominal(env, chatId, uid, Number(i), Number(j)); }
    if (data.startsWith("pv:")) { const [, i, j, amt] = data.split(":"); return execPindah(env, chatId, uid, Number(i), Number(j), Number(amt)); }
    // Set saldo: dompet -> nominal
    if (data.startsWith("ssw:")) return wSetSaldoNominal(env, chatId, uid, Number(data.slice(4)));
    if (data.startsWith("ssv:")) { const [, i, amt] = data.split(":"); return execSetSaldo(env, chatId, uid, Number(i), Number(amt)); }
    // Tarik tunai nominal
    if (data.startsWith("mv:")) return recordFlow(env, chatId, uid, "tarik " + Number(data.slice(3)));
    // Budget
    if (data.startsWith("bgv:")) return handleBudget(env, chatId, uid, String(Number(data.slice(4))), BACK_MENU);
    // Dompet kelola
    if (data.startsWith("dw_del:")) return dompetByIndex(env, chatId, uid, "hapus", Number(data.slice(7)));
    if (data.startsWith("dw_main:")) return dompetByIndex(env, chatId, uid, "utama", Number(data.slice(8)));
    // Laporan bulan tertentu
    if (data.startsWith("lap:")) return sendReport(env, chatId, uid, BACK_MENU, data.slice(4));
    // Pilih "✏️ Ketik nominal" pada picker -> set mode lalu minta ketik.
    if (data.startsWith("typeamt:")) {
      await setMode(env, uid, data.slice(8));
      return sendMessage(env, chatId, "✏️ Ketik nominal (mis. 75rb):", BACK_MENU);
    }
    // Preset keterangan: pilih -> tinggal ketik nominal.
    if (data.startsWith("pn:")) {
      const [, kind, i] = data.split(":");
      const cfg = await getConfig(env, uid);
      const note = presetsFor(cfg, kind)[Number(i)];
      if (!note) return sendMessage(env, chatId, "Preset tak ada, coba lagi.", BACK_MENU);
      await setMode(env, uid, `note:${kind}:${note}`);
      const emo = kind === "masuk" ? "🟢" : "🔴";
      return sendMessage(env, chatId, `${emo} ${note} — ketik nominalnya saja (mis. 25rb):`, BACK_MENU);
    }
    if (data.startsWith("free:")) {
      const kind = data.slice(5);
      await setMode(env, uid, kind);
      const ex = kind === "masuk" ? "5jt gaji" : "50rb makan siang";
      return sendMessage(env, chatId, `✏️ Ketik nominal + keterangan\ncontoh: ${ex}`, BACK_MENU);
    }
    if (data.startsWith("pmng:")) return sendPresetManage(env, chatId, uid, data.slice(5));
    if (data.startsWith("padd:")) {
      const kind = data.slice(5);
      await setMode(env, uid, `padd:${kind}`);
      return sendMessage(env, chatId, "➕ Ketik nama preset baru (mis. Rokok, Galon, Kos):", BACK_MENU);
    }
    if (data.startsWith("pdel:")) {
      const [, kind, i] = data.split(":");
      await removePreset(env, uid, kind, Number(i));
      return sendPresetManage(env, chatId, uid, kind);
    }
    if (data.startsWith("prst:")) {
      const kind = data.slice(5);
      const cfg = await getConfig(env, uid);
      cfg[presetField(kind)] = null;
      await saveConfig(env, uid, cfg);
      return sendPresetManage(env, chatId, uid, kind);
    }
    // Hutang/piutang berbasis tombol: pilih nama -> pilih nominal.
    if (data.startsWith("dp:")) {
      const [, kind, i] = data.split(":");
      const parties = recentParties(await getEntries(env, uid), kind);
      const party = parties[Number(i)];
      if (!party) return sendMessage(env, chatId, "Nama tak ada, coba lagi.", BACK_MENU);
      return debtPickedParty(env, chatId, uid, kind, party);
    }
    if (data.startsWith("dpnew:")) {
      const kind = data.slice(6);
      await setMode(env, uid, `debtname:${kind}`);
      const sisi = kind === "hutang" ? "kamu pinjam ke siapa" : "siapa yang pinjam ke kamu";
      return sendMessage(env, chatId, `✍️ Ketik nama (${sisi}):`, BACK_MENU);
    }
    if (data.startsWith("dpfull:")) {
      const kind = data.slice(7);
      await setMode(env, uid, kind);
      return sendMessage(env, chatId, `✏️ Ketik lengkap: nominal nama [ket] [tgl]\ncontoh: 100rb budi bensin tgl 15-3-2025`, BACK_MENU);
    }
    if (data.startsWith("dv:")) return execDebt(env, chatId, uid, Number(data.slice(3)));
    // Verifikasi hasil scan struk.
    if (data.startsWith("rv:")) return execReceipt(env, chatId, uid, data.slice(3));
    if (data.startsWith("rw:")) { const [, kind, i] = data.split(":"); return execReceiptSave(env, chatId, uid, kind, Number(i)); }
    // Pilih dompet untuk input preset (keluar/masuk).
    if (data.startsWith("cw:")) return execCatat(env, chatId, uid, Number(data.slice(3)));
    if (data === "rv_amt") {
      await setMode(env, uid, "rcptamt");
      return sendMessage(env, chatId, "✏️ Ketik nominal yang benar (mis. 50rb):", BACK_MENU);
    }

    // Kembali ke menu/kategori -> bersihkan mode nyangkut biar ketikan berikutnya tak salah tafsir.
    if (data === "menu" || data.startsWith("cat_")) await clearMode(env, uid);

    switch (data) {
      case "menu": return sendMenu(env, chatId);
      // Submenu kategori
      case "cat_catat": return sendMessage(env, chatId, "➕ Catat transaksi:", MENU_CATAT);
      case "cat_laporan": return sendMessage(env, chatId, "📊 Laporan & data:", MENU_LAPORAN);
      case "cat_utang": return sendMessage(env, chatId, "📋 Hutang & Piutang:", MENU_UTANG);
      case "cat_budget": return sendMessage(env, chatId, "🎯 Budget:", MENU_BUDGET);
      case "cat_dompet": return sendMessage(env, chatId, "👛 Dompet:", MENU_DOMPET);
      case "cat_lain": return sendMessage(env, chatId, "🧰 Lainnya:", MENU_LAIN);
      case "saldo": return sendSaldo(env, chatId, uid, BACK_MENU);
      case "dompet": return sendDompetMenu(env, chatId, uid);
      // Aksi (hasil selalu ada tombol balik)
      case "laporan": return sendReport(env, chatId, uid, BACK_MENU);
      case "lap_pick": return sendMonthPicker(env, chatId, uid);
      case "grafik": return sendChart(env, chatId, uid, BACK_MENU);
      case "cari":
        await setMode(env, uid, "cari");
        return sendMessage(env, chatId, "🔍 Ketik kata yang dicari (mis. grab):", BACK_MENU);
      case "utang": return sendDebtReport(env, chatId, uid, BACK_MENU);
      case "total": return sendTotal(env, chatId, uid, BACK_MENU);
      case "budget": return handleBudget(env, chatId, uid, "", BACK_MENU);
      case "budget_set": return sendNominalPicker(env, chatId, "🎯 Set budget bulanan:", "bgv", BIG_PRESET, "budget");
      case "budget_off": return handleBudget(env, chatId, uid, "off", BACK_MENU);
      case "lunas": return handleLunas(env, chatId, uid, "", BACK_MENU);
      case "export": return exportCsv(env, chatId, uid, BACK_MENU);
      case "excel": return exportExcel(env, chatId, uid, BACK_MENU);
      case "ai": return handleAi(env, chatId, uid, "");
      case "backup": return handleBackup(env, chatId, uid, BACK_MENU);
      case "restore":
        return sendMessage(env, chatId, "📥 Kirim file backup (.json) ke sini untuk memulihkan data.", BACK_MENU);
      case "hari":
        return sendMessage(env, chatId, `📆 Sekarang: ${namaHariTanggal(Date.now())} (WIB)`, BACK_MENU);
      case "help": return sendMessage(env, chatId, helpText(), BACK_MENU);
      case "edit": return sendEditList(env, chatId, uid);
      case "add_keluar":
        return sendCatatPicker(env, chatId, uid, "keluar");
      case "add_masuk":
        return sendCatatPicker(env, chatId, uid, "masuk");
      case "add_mutasi":
        return sendNominalPicker(env, chatId, "💵 Tarik tunai berapa? (Bank → Cash)", "mv", CASH_PRESET, "mutasi");
      case "add_pindah":
        return wPindahFrom(env, chatId, uid);
      case "add_setsaldo":
        return wSetSaldoWallet(env, chatId, uid);
      case "dw_add":
        await setMode(env, uid, "dompet_add");
        return sendMessage(env, chatId, "➕ Ketik nama dompet baru (mis. GoPay):", BACK_MENU);
      case "dw_delp": return sendWalletPicker(env, chatId, uid, "🗑️ Hapus dompet mana?", "dw_del");
      case "dw_mainp": return sendWalletPicker(env, chatId, uid, "⭐ Jadikan dompet utama:", "dw_main");
      case "add_hutang": await clearDebtDraft(env, uid); return wDebtParty(env, chatId, uid, "hutang");
      case "add_piutang": await clearDebtDraft(env, uid); return wDebtParty(env, chatId, uid, "piutang");
    }
  } catch (e) {
    return sendMessage(env, chatId, "Error: " + (e && e.message ? e.message : e));
  }
}

async function routeMessage(env, chatId, msg) {
  const uid = msg.from.id;

  // Foto (struk atau impor screenshot)
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const pmode = await getMode(env, uid);
    if (pmode) await clearMode(env, uid);
    const cap = (msg.caption || "").trim().toLowerCase();
    if (pmode === "impor" || /^(impor|import)\b/.test(cap)) {
      return handleImportScreenshot(env, chatId, msg);
    }
    return handleReceiptPhoto(env, chatId, msg, pmode);
  }

  // File dikirim (untuk restore backup .json)
  if (msg.document) return handleRestoreUpload(env, chatId, msg);

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
  if (lower.startsWith("/excel")) return exportExcel(env, chatId, uid);
  if (lower.startsWith("/export")) return exportCsv(env, chatId, uid);
  if (lower.startsWith("/ai")) return handleAi(env, chatId, uid, text.slice(3).trim());
  if (lower.startsWith("/impor") || lower.startsWith("/import")) return handleImportStart(env, chatId, uid);
  if (lower.startsWith("/backup")) return handleBackup(env, chatId, uid);
  if (lower.startsWith("/restore")) return sendMessage(env, chatId, "📥 Kirim file backup (.json) ke sini untuk memulihkan data.", BACK_MENU);
  if (lower.startsWith("/hapus")) return handleHapus(env, chatId, uid, text.slice(6).trim());
  if (lower.startsWith("/hari") || lower.startsWith("/tanggal")) return sendMessage(env, chatId, `📆 Sekarang: ${namaHariTanggal(Date.now())} (WIB)`);
  if (lower.startsWith("/budget")) return handleBudget(env, chatId, uid, text.slice(7).trim());
  if (lower.startsWith("/lunas")) return handleLunas(env, chatId, uid, text.slice(6).trim());
  if (lower.startsWith("/utang") || lower.startsWith("/rekaputang")) return sendDebtReport(env, chatId, uid);
  if (lower.startsWith("/saldo")) return sendSaldo(env, chatId, uid);
  if (lower.startsWith("/dompet")) return handleDompet(env, chatId, uid, text.slice(7).trim());
  if (lower.startsWith("/pindah") || lower.startsWith("/transfer")) return recordFlow(env, chatId, uid, text.slice(1));
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
  const cfg = await getConfig(env, uid);
  const tgl = parseTanggal(flow.note);
  const ts = tgl.ts || Date.now();
  const waktu = `\n🗓️ ${namaHariTanggal(ts)} · ${jamPendek(ts)}`;

  // Mutasi: tarik tunai / pindah antar dompet. Tidak dihitung pengeluaran.
  if (flow.kind === "mutasi") {
    let from, to, note;
    if (flow.move === "pindah") {
      const parts = tgl.rest.split(/\s+/).filter(Boolean);
      from = resolveWallet(parts[0], cfg);
      to = resolveWallet(parts[1], cfg);
      if (!from || !to) {
        return sendMessage(env, chatId, `Format: pindah 200rb <dari> <ke>\nDompet: ${cfg.wallets.join(", ")}`, BACK_MENU);
      }
      note = `pindah ${from}→${to}`;
    } else {
      from = bankWallet(cfg);
      to = cashWallet(cfg);
      note = tgl.rest || "tarik tunai";
    }
    await addEntry(env, uid, { kind: "mutasi", amount: flow.amount, note, from, to, ts, src: "teks" });
    return sendMessage(
      env,
      chatId,
      `💵 ${fmtRp(flow.amount)} — ${from} → ${to}${waktu}\n(pindah dompet, bukan pengeluaran)`,
      BACK_MENU,
    );
  }

  // Ambil tag @dompet (default = dompet utama).
  const w = extractWallet(tgl.rest, cfg);
  const wallet = w.wallet || cfg.defaultWallet;
  const { category, note } = resolveCategory(w.rest);
  await addEntry(env, uid, { kind: flow.kind, amount: flow.amount, note, category, wallet, ts, src: "teks" });
  const label = flow.kind === "masuk" ? "Pemasukan" : "Pengeluaran";
  const icon = flow.kind === "masuk" ? "🟢" : "🔴";
  if (flow.kind === "masuk") {
    return sendMessage(env, chatId, `${icon} ${label} tercatat: ${fmtRp(flow.amount)} — ${note} (${wallet})${waktu}`, BACK_MENU);
  }
  const extra = await spendingSummaryLines(env, uid);
  return sendMessage(
    env,
    chatId,
    [`${icon} ${label} tercatat: ${fmtRp(flow.amount)} — ${note} [${category}] (${wallet})${waktu}`, ...extra].join("\n"),
    BACK_MENU,
  );
}

// Proses input teks setelah menekan tombol (mode aktif).
async function handleModeInput(env, chatId, uid, mode, text) {
  if (mode === "keluar") return recordFlow(env, chatId, uid, text);
  if (mode === "masuk") return recordFlow(env, chatId, uid, "+" + text.replace(/^\+/, ""));
  if (mode === "mutasi") return recordFlow(env, chatId, uid, "tarik " + text);
  if (mode === "pindah") return recordFlow(env, chatId, uid, "pindah " + text);
  if (mode === "setsaldo") return handleDompet(env, chatId, uid, "saldo " + text);
  if (mode === "hutang") return handleDebt(env, chatId, uid, "hutang", text);
  if (mode === "piutang") return handleDebt(env, chatId, uid, "piutang", text);
  if (mode === "cari") return handleCari(env, chatId, uid, text.trim());
  if (mode === "budget") return handleBudget(env, chatId, uid, text.trim(), BACK_MENU);
  if (mode === "dompet_add") return handleDompet(env, chatId, uid, "tambah " + text.trim());
  if (mode.startsWith("note:")) {
    const rest = mode.slice(5);
    const sep = rest.indexOf(":");
    const kind = rest.slice(0, sep);
    const note = rest.slice(sep + 1);
    const p = parseAmountToken(text);
    if (!p) return sendMessage(env, chatId, "Nominal tak terbaca. Contoh: 25rb", BACK_MENU);
    return sendCatatWalletPicker(env, chatId, uid, kind, p.amount, note);
  }
  if (mode.startsWith("padd:")) {
    const kind = mode.slice(5);
    await addPreset(env, uid, kind, text);
    await sendMessage(env, chatId, `✅ Preset "${text.trim()}" ditambah.`);
    return sendCatatPicker(env, chatId, uid, kind);
  }
  if (mode.startsWith("debtname:")) {
    const kind = mode.slice(9);
    const party = text.trim().slice(0, 30) || "-";
    return debtPickedParty(env, chatId, uid, kind, party);
  }
  if (mode === "rcptamt") {
    const p = parseAmountToken(text);
    if (!p) return sendMessage(env, chatId, "Nominal tak terbaca. Contoh: 50rb", BACK_MENU);
    const d = await getReceiptDraft(env, uid);
    if (!d) return sendMessage(env, chatId, "Sesi scan kadaluarsa. Kirim ulang fotonya.", BACK_MENU);
    d.amount = p.amount;
    return sendReceiptVerify(env, chatId, uid, { amount: d.amount, toko: d.toko }, d.note);
  }
  if (mode === "debtamt") {
    const p = parseAmountToken(text);
    if (!p) return sendMessage(env, chatId, "Nominal tak terbaca. Contoh: 100rb", BACK_MENU);
    return execDebt(env, chatId, uid, p.amount);
  }
  // Pindah ketik-nominal: mode "pindahamt:<i>:<j>"
  if (mode.startsWith("pindahamt:")) {
    const [, i, j] = mode.split(":");
    const p = parseAmountToken(text);
    if (!p) return sendMessage(env, chatId, "Nominal tak terbaca. Contoh: 200rb", BACK_MENU);
    return execPindah(env, chatId, uid, Number(i), Number(j), p.amount);
  }
  // Set saldo ketik-nominal: mode "setsaldoamt:<i>"
  if (mode.startsWith("setsaldoamt:")) {
    const p = parseAmountToken(text);
    if (!p) return sendMessage(env, chatId, "Nominal tak terbaca. Contoh: 5jt", BACK_MENU);
    return execSetSaldo(env, chatId, uid, Number(mode.slice(12)), p.amount);
  }
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

async function handleReceiptPhoto(env, chatId, msg, mode) {
  if (!env.AI && !env.GEMINI_API_KEY) {
    return sendMessage(env, chatId, "Fitur foto struk belum aktif (binding Workers AI 'AI' atau GEMINI_API_KEY belum diset).");
  }
  await sendMessage(env, chatId, "📸 Membaca struk...");

  const photo = msg.photo[msg.photo.length - 1]; // ukuran terbesar
  const bytes = await getTelegramFile(env, photo.file_id);

  const cfgAi = await getConfig(env, msg.from.id);
  const result = await readReceipt(env, bytes, cfgAi.useGemini);
  if (!result || !result.amount) {
    const why = result && result.debug ? `\n\n(debug: ${result.debug})` : "";
    return sendMessage(
      env,
      chatId,
      "Maaf, total di struk tidak terbaca. Coba foto lebih jelas & lurus, atau ketik manual (mis. '50rb belanja')." + why,
    );
  }

  const uid = msg.from.id;
  // Tentukan jenis dari caption foto atau mode tombol yang aktif.
  const cls = classifyPhoto(msg.caption || "", mode);

  // Tanpa petunjuk jenis -> tampilkan menu verifikasi dulu.
  if (!cls.explicit) return sendReceiptVerify(env, chatId, uid, result, cls.note);

  if (cls.kind === "hutang" || cls.kind === "piutang") {
    const party = cls.party || "-";
    const note = cls.note || result.toko || "struk";
    await addEntry(env, uid, { kind: cls.kind, amount: result.amount, note, party, status: "belum", src: "foto" });
    const label = cls.kind === "hutang" ? "📕 Hutang (struk)" : "📗 Piutang (struk)";
    return sendMessage(env, chatId, `${label}: ${fmtRp(result.amount)} — ${party} (${note})`, BACK_MENU);
  }

  if (cls.kind === "masuk") {
    const note = cls.note || result.toko || "pemasukan";
    await addEntry(env, uid, { kind: "masuk", amount: result.amount, note, src: "foto" });
    return sendMessage(env, chatId, `🟢 Pemasukan (struk): ${fmtRp(result.amount)} — ${note}`, BACK_MENU);
  }

  if (cls.kind === "mutasi") {
    const cfg = await getConfig(env, uid);
    const from = bankWallet(cfg);
    const to = cashWallet(cfg);
    const note = cls.note || "tarik tunai";
    await addEntry(env, uid, { kind: "mutasi", amount: result.amount, note, from, to, src: "foto" });
    return sendMessage(
      env,
      chatId,
      `💵 Tarik tunai (struk): ${fmtRp(result.amount)} — ${from} → ${to}\n(pindah dompet, bukan pengeluaran)`,
      BACK_MENU,
    );
  }

  // default: pengeluaran
  const note = cls.note || result.toko || "struk";
  const category = categorize(note);
  await addEntry(env, uid, { kind: "keluar", amount: result.amount, note, category, src: "foto" });
  const extra = await spendingSummaryLines(env, uid);
  return sendMessage(
    env,
    chatId,
    [
      `🔴 Pengeluaran (struk): ${fmtRp(result.amount)} — ${note} [${category}]`,
      ...extra,
      "",
      "ℹ️ Kalau ini hutang/piutang: kirim ulang foto dgn caption 'piutang <nama>' atau 'hutang <nama>'.",
    ].join("\n"),
    BACK_MENU,
  );
}

// Tentukan jenis catatan dari caption foto / mode tombol.
// caption: "piutang andi", "hutang budi bensin", "masuk", atau bebas (jadi keterangan).
function classifyPhoto(caption, mode) {
  const cap = caption.trim();
  const m = cap.match(/^(hutang|piutang)\b\s*(.*)$/i);
  if (m) {
    const parts = m[2].split(/\s+/).filter(Boolean);
    const party = parts.shift() || "";
    return { kind: m[1].toLowerCase(), party, note: parts.join(" "), explicit: true };
  }
  if (/^(tarik\s*tunai|tarik|tunai)\b/i.test(cap)) {
    return { kind: "mutasi", note: cap.replace(/^(tarik\s*tunai|tarik|tunai)\s*/i, ""), explicit: true };
  }
  if (/^(masuk|pemasukan|\+)/i.test(cap)) {
    return { kind: "masuk", note: cap.replace(/^(masuk|pemasukan|\+)\s*/i, ""), explicit: true };
  }
  if (mode === "mutasi") return { kind: "mutasi", note: cap, explicit: true };
  if (mode === "hutang" || mode === "piutang") {
    const parts = cap.split(/\s+/).filter(Boolean);
    const party = parts.shift() || "";
    return { kind: mode, party, note: parts.join(" "), explicit: true };
  }
  if (mode === "masuk") return { kind: "masuk", note: cap, explicit: true };
  // Tanpa caption/mode jelas: keterangan = caption bebas (kalau ada), belum pasti jenisnya.
  return { kind: "keluar", note: cap, explicit: false };
}

// Menu verifikasi setelah scan struk: pilih jenis catatannya.
async function sendReceiptVerify(env, chatId, uid, result, note) {
  await setReceiptDraft(env, uid, { amount: result.amount, toko: result.toko || "", note: note || "" });
  const rows = [
    [{ text: "🔴 Pengeluaran", callback_data: "rv:keluar" }, { text: "🟢 Pemasukan", callback_data: "rv:masuk" }],
    [{ text: "📕 Hutang", callback_data: "rv:hutang" }, { text: "📗 Piutang", callback_data: "rv:piutang" }],
    [{ text: "💵 Tarik tunai", callback_data: "rv:mutasi" }],
    [{ text: "✏️ Ubah nominal", callback_data: "rv_amt" }, { text: "❌ Batal", callback_data: "menu" }],
  ];
  const toko = result.toko ? ` — ${result.toko}` : "";
  return sendMessage(env, chatId, `🧾 Terbaca: ${fmtRp(result.amount)}${toko}\nMau dicatat sebagai apa?`, kb(rows));
}

// Jenis dipilih di menu verifikasi.
async function execReceipt(env, chatId, uid, kind) {
  const d = await getReceiptDraft(env, uid);
  if (!d) return sendMessage(env, chatId, "Sesi scan kadaluarsa. Kirim ulang foto struknya ya.", BACK_MENU);
  const note = d.note || d.toko || "struk";
  if (kind === "hutang" || kind === "piutang") {
    // Nominal sudah ada dari struk; tinggal pilih nama.
    await clearReceiptDraft(env, uid);
    await setDebtDraft(env, uid, { kind, amount: d.amount, note });
    return wDebtParty(env, chatId, uid, kind);
  }
  if (kind === "mutasi") {
    await clearReceiptDraft(env, uid);
    const cfg = await getConfig(env, uid);
    const from = bankWallet(cfg), to = cashWallet(cfg);
    await addEntry(env, uid, { kind: "mutasi", amount: d.amount, note: "tarik tunai", from, to, src: "foto" });
    return sendMessage(env, chatId, `💵 Tarik tunai (struk): ${fmtRp(d.amount)} — ${from} → ${to}\n(pindah dompet, bukan pengeluaran)`, BACK_MENU);
  }
  // keluar / masuk -> pilih dompet dulu.
  const cfg = await getConfig(env, uid);
  const rows = chunk(cfg.wallets.map((w, i) => ({ text: w, callback_data: `rw:${kind}:${i}` })), 2);
  rows.push([{ text: "⭐ Default (" + cfg.defaultWallet + ")", callback_data: `rw:${kind}:-1` }]);
  rows.push([{ text: "🚫 Tanpa dompet (tak ubah saldo)", callback_data: `rw:${kind}:-2` }]);
  rows.push([BACK_BTN]);
  const emo = kind === "masuk" ? "🟢 Pemasukan" : "🔴 Pengeluaran";
  return sendMessage(env, chatId, `${emo} ${fmtRp(d.amount)} — ${note}\nDari/ke dompet mana?`, kb(rows));
}

// Dompet dipilih -> simpan pemasukan/pengeluaran dari struk.
async function execReceiptSave(env, chatId, uid, kind, walletIdx) {
  const d = await getReceiptDraft(env, uid);
  if (!d) return sendMessage(env, chatId, "Sesi scan kadaluarsa. Kirim ulang foto struknya ya.", BACK_MENU);
  const cfg = await getConfig(env, uid);
  const wallet = walletIdx === -2 ? NO_WALLET : (walletIdx < 0 ? cfg.defaultWallet : (cfg.wallets[walletIdx] || cfg.defaultWallet));
  const note = d.note || d.toko || "struk";
  await clearReceiptDraft(env, uid);
  if (kind === "masuk") {
    await addEntry(env, uid, { kind: "masuk", amount: d.amount, note, wallet, src: "foto" });
    return sendMessage(env, chatId, `🟢 Pemasukan (struk): ${fmtRp(d.amount)} — ${note} (${wallet})`, BACK_MENU);
  }
  const category = categorize(note);
  await addEntry(env, uid, { kind: "keluar", amount: d.amount, note, category, wallet, src: "foto" });
  const extra = await spendingSummaryLines(env, uid);
  return sendMessage(env, chatId, [`🔴 Pengeluaran (struk): ${fmtRp(d.amount)} — ${note} [${category}] (${wallet})`, ...extra].join("\n"), BACK_MENU);
}
function receiptDraftKey(uid) { return `rcpt:${uid}`; }
async function setReceiptDraft(env, uid, d) { await env.EXPENSES.put(receiptDraftKey(uid), JSON.stringify(d), { expirationTtl: 900 }); }
async function getReceiptDraft(env, uid) { const r = await env.EXPENSES.get(receiptDraftKey(uid)); return r ? JSON.parse(r) : null; }
async function clearReceiptDraft(env, uid) { await env.EXPENSES.delete(receiptDraftKey(uid)); }

// Input preset (keluar/masuk): pilih dompet sebelum simpan.
async function sendCatatWalletPicker(env, chatId, uid, kind, amount, note) {
  await setCatatDraft(env, uid, { kind, amount, note });
  const cfg = await getConfig(env, uid);
  const rows = chunk(cfg.wallets.map((w, i) => ({ text: w, callback_data: `cw:${i}` })), 2);
  rows.push([{ text: "⭐ Default (" + cfg.defaultWallet + ")", callback_data: "cw:-1" }]);
  rows.push([{ text: "🚫 Tanpa dompet (tak ubah saldo)", callback_data: "cw:-2" }]);
  rows.push([BACK_BTN]);
  const emo = kind === "masuk" ? "🟢 Pemasukan" : "🔴 Pengeluaran";
  return sendMessage(env, chatId, `${emo} ${fmtRp(amount)} — ${note}\nPakai dompet mana?`, kb(rows));
}
async function execCatat(env, chatId, uid, walletIdx) {
  const d = await getCatatDraft(env, uid);
  if (!d) return sendMessage(env, chatId, "Sesi kadaluarsa, ulangi dari menu.", BACK_MENU);
  const cfg = await getConfig(env, uid);
  const wallet = walletIdx === -2 ? NO_WALLET : (walletIdx < 0 ? cfg.defaultWallet : (cfg.wallets[walletIdx] || cfg.defaultWallet));
  await clearCatatDraft(env, uid);
  if (d.kind === "masuk") {
    await addEntry(env, uid, { kind: "masuk", amount: d.amount, note: d.note, wallet, src: "tombol" });
    return sendMessage(env, chatId, `🟢 Pemasukan: ${fmtRp(d.amount)} — ${d.note} (${wallet})`, BACK_MENU);
  }
  const r = resolveCategory(d.note);
  await addEntry(env, uid, { kind: "keluar", amount: d.amount, note: r.note, category: r.category, wallet, src: "tombol" });
  const extra = await spendingSummaryLines(env, uid);
  return sendMessage(env, chatId, [`🔴 Pengeluaran: ${fmtRp(d.amount)} — ${r.note} [${r.category}] (${wallet})`, ...extra].join("\n"), BACK_MENU);
}
function catatDraftKey(uid) { return `cdraft:${uid}`; }
async function setCatatDraft(env, uid, d) { await env.EXPENSES.put(catatDraftKey(uid), JSON.stringify(d), { expirationTtl: 900 }); }
async function getCatatDraft(env, uid) { const r = await env.EXPENSES.get(catatDraftKey(uid)); return r ? JSON.parse(r) : null; }
async function clearCatatDraft(env, uid) { await env.EXPENSES.delete(catatDraftKey(uid)); }

// Pilih mesin OCR: Gemini (akurat) kalau key ada & diizinkan, jika tidak Workers AI.
async function readReceipt(env, arrayBuffer, useGemini = true) {
  if (env.GEMINI_API_KEY && useGemini) {
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

  const ts = tgl.ts || Date.now();
  await addEntry(env, uid, {
    kind, amount: p.amount, note, party, status: "belum", ts, src: "teks",
  });
  const label =
    kind === "hutang"
      ? `📕 Hutang dicatat: kamu pinjam ${fmtRp(p.amount)} ke ${party}`
      : `📗 Piutang dicatat: ${party} pinjam ${fmtRp(p.amount)} ke kamu`;
  const waktu = `\n🗓️ ${namaHariTanggal(ts)} · ${jamPendek(ts)}`;
  return sendMessage(env, chatId, `${label}${note ? ` (${note})` : ""}${waktu}`, BACK_MENU);
}

// Ambil tanggal kejadian dari teks: "tgl 15-3-2025", "tanggal 15/3", "pada 1 1 2024".
// Kembalikan { ts, rest }. Kalau tanpa tahun -> pakai tahun sekarang.
function parseTanggal(s) {
  const m = s.match(/(?:tgl|tanggal|pada)\s*[:=]?\s*(\d{1,2})[-/ ](\d{1,2})(?:[-/ ](\d{2,4}))?(?:\s+(?:jam\s*)?(\d{1,2})[:.](\d{2}))?/i);
  if (!m) return { ts: 0, rest: s };
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  let y = m[3] ? parseInt(m[3], 10) : wibParts(Date.now()).y;
  if (y < 100) y += 2000;
  if (!d || d > 31 || !mo || mo > 12) return { ts: 0, rest: s };
  // Jam opsional; kalau tak ditulis pakai tengah hari (aman dari geser zona waktu).
  let hh = 12, mm = 0;
  if (m[4] != null) { hh = parseInt(m[4], 10); mm = parseInt(m[5], 10); }
  if (hh > 23 || mm > 59) { hh = 12; mm = 0; }
  const ts = Date.UTC(y, mo - 1, d, hh, mm, 0) - WIB_OFFSET_MS;
  const rest = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  return { ts, rest };
}

// Jam singkat "14:30" (WIB).
function jamPendek(ts) {
  const d = new Date(ts + WIB_OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
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
    lines.push(`${n}. ${fmtRp(e.amount)} — ${e.party} (${e.note}) · ${tglPendek(e.ts)} ${jamPendek(e.ts)}`);
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
    for (const e of hutang) lines.push(`• ${fmtRp(e.amount)} — ${e.party} (${e.note}) · ${tglPendek(e.ts)} ${jamPendek(e.ts)}`);
  } else {
    lines.push("• (tidak ada)");
  }

  lines.push("", `📗 Piutang (orang pinjam) — ${fmtRp(totalP)}`);
  if (piutang.length) {
    for (const e of piutang) lines.push(`• ${fmtRp(e.amount)} — ${e.party} (${e.note}) · ${tglPendek(e.ts)} ${jamPendek(e.ts)}`);
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
  const c = raw ? JSON.parse(raw) : {};
  return {
    budget: c.budget || 0,
    wallets: Array.isArray(c.wallets) && c.wallets.length ? c.wallets : ["Cash", "Bank"],
    defaultWallet: c.defaultWallet || "Cash",
    useGemini: c.useGemini !== false, // default true (pakai Gemini bila key ada)
    presets: Array.isArray(c.presets) ? c.presets : null, // pengeluaran; null = default
    incomePresets: Array.isArray(c.incomePresets) ? c.incomePresets : null, // pemasukan
  };
}

// Preset keterangan cepat (default + custom user), per arah kas.
const DEFAULT_PRESETS = ["Makan", "Kopi", "Jajan", "Bensin", "Parkir", "Belanja", "Pulsa", "Grab"];
const DEFAULT_INCOME_PRESETS = ["Gaji", "Bonus", "THR", "Transferan", "Jualan", "Bunga"];
function presetField(kind) { return kind === "masuk" ? "incomePresets" : "presets"; }
function presetsFor(cfg, kind) {
  const def = kind === "masuk" ? DEFAULT_INCOME_PRESETS : DEFAULT_PRESETS;
  const cur = cfg[presetField(kind)];
  return cur && cur.length ? cur : def;
}

// Cari nama dompet yang cocok (case-insensitive).
function resolveWallet(name, cfg) {
  if (!name) return "";
  return cfg.wallets.find((w) => w.toLowerCase() === name.toLowerCase()) || "";
}
function cashWallet(cfg) {
  return cfg.wallets.find((w) => /cash|tunai/i.test(w)) || cfg.defaultWallet;
}
function bankWallet(cfg) {
  return cfg.wallets.find((w) => /bank/i.test(w)) || cfg.wallets.find((w) => w !== cashWallet(cfg)) || cfg.defaultWallet;
}

// Ambil tag "@dompet" dari teks; kembalikan { wallet, rest }.
function extractWallet(text, cfg) {
  const m = text.match(/@(\S+)/);
  if (!m) return { wallet: "", rest: text };
  const w = resolveWallet(m[1], cfg);
  if (!w) return { wallet: "", rest: text }; // tag tak dikenal -> biarkan
  const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  return { wallet: w, rest };
}

// Hitung saldo tiap dompet dari seluruh catatan.
function walletBalances(list, cfg) {
  const bal = {};
  for (const w of cfg.wallets) bal[w] = 0;
  const add = (w, n) => {
    if (!w || w === NO_WALLET) return; // "tanpa dompet" tak mempengaruhi saldo
    bal[w] = (bal[w] || 0) + n;
  };
  for (const e of list) {
    if (e.kind === "masuk") add(e.wallet || cfg.defaultWallet, e.amount);
    else if (e.kind === "keluar") add(e.wallet || cfg.defaultWallet, -e.amount);
    else if (e.kind === "mutasi") {
      add(e.from, -e.amount);
      add(e.to, e.amount);
    }
  }
  return bal;
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
    kind: entry.kind, // keluar | masuk | hutang | piutang | mutasi
    amount: entry.amount,
    note: entry.note,
    category: entry.category || "",
    party: entry.party || "",
    status: entry.status || "",
    wallet: entry.wallet || "", // dompet (masuk/keluar)
    from: entry.from || "", // dompet asal (mutasi)
    to: entry.to || "", // dompet tujuan (mutasi)
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
      lines.push(`${icon} ${jamPendek(e.ts)} · ${fmtRp(e.amount)} — ${e.note}${e.src === "foto" ? " 🧾" : ""}`);
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
    lines.push(`${icon} ${tglPendek(e.ts)} ${jamPendek(e.ts)} — ${fmtRp(e.amount)} — ${e.note}${e.party ? " / " + e.party : ""}`);
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

  const header = ["Bulan", "Tanggal", "Waktu", "Jenis", "Masuk", "Keluar", "Saldo", "Kategori", "Keterangan", "Pihak", "Dompet", "Status", "Sumber"];
  const rows = [header.map(csvCell).join(",")];
  let saldo = 0; // saldo berjalan (total semua dompet), seperti rekening koran
  for (const e of [...list].sort((a, b) => a.ts - b.ts)) {
    const d = new Date(e.ts + WIB_OFFSET_MS);
    const bulan = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    const tgl = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
    const jam = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    const dompet = e.kind === "mutasi" ? `${e.from || ""}→${e.to || ""}` : e.wallet || "";

    // Efek ke saldo total: masuk +, keluar -, mutasi injeksi/penarikan; transfer & hutang/piutang = 0
    let masukN = "", keluarN = "";
    if (e.kind === "masuk") { saldo += e.amount; masukN = e.amount; }
    else if (e.kind === "keluar") { saldo -= e.amount; keluarN = e.amount; }
    else if (e.kind === "mutasi") {
      if (e.to && !e.from) { saldo += e.amount; masukN = e.amount; }       // set saldo naik
      else if (e.from && !e.to) { saldo -= e.amount; keluarN = e.amount; } // set saldo turun
      // transfer antar dompet: saldo total tetap
    }

    rows.push(
      [bulan, tgl, jam, e.kind, masukN, keluarN, saldo, e.category || "", e.note, e.party || "", dompet, e.status || "", e.src || ""]
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

// ---------------------------------------------------------------------------
// Export Excel (.xlsx) — per bulan jadi sheet, format Rupiah, saldo berjalan.
// XLSX ditulis manual (tanpa library): kumpulan XML dibungkus ZIP (stored).
// ---------------------------------------------------------------------------

async function exportExcel(env, chatId, uid, markup) {
  const list = await getEntries(env, uid);
  if (!list.length) return sendMessage(env, chatId, "Belum ada catatan untuk diexport.", markup);
  if (list.length > 8000) {
    return sendMessage(env, chatId, "Data terlalu banyak untuk Excel. Pakai /export (CSV) saja ya.", markup);
  }
  const cfg = await getConfig(env, uid);
  const bytes = buildExcel(list, cfg);
  const now = wibParts(Date.now());
  await sendDocument(
    env,
    chatId,
    bytes,
    `laporan-${now.y}${pad(now.m)}.xlsx`,
    "📊 Laporan Excel — per bulan, format Rupiah, saldo berjalan.",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  if (markup) await sendMessage(env, chatId, "Selesai. 👇", markup);
}

// ---------------------------------------------------------------------------
// Backup & Restore (JSON)
// ---------------------------------------------------------------------------

function rstKey(uid) {
  return `rst:${uid}`;
}

// /backup -> kirim file JSON berisi semua data (transaksi + config).
async function handleBackup(env, chatId, uid, markup) {
  const [entries, cfg] = await Promise.all([getEntries(env, uid), getConfig(env, uid)]);
  const payload = {
    app: "catatan-bot",
    version: 1,
    exportedAt: new Date().toISOString(),
    config: cfg,
    entries,
  };
  const now = wibParts(Date.now());
  await sendDocument(
    env,
    chatId,
    JSON.stringify(payload),
    `backup-${now.y}${pad(now.m)}${pad(now.d)}.json`,
    `🗂️ Backup ${entries.length} catatan. Simpan file ini.\nPulihkan: kirim balik file ini ke bot.`,
    "application/json",
  );
  if (markup) await sendMessage(env, chatId, "Selesai. 👇", markup);
}

// ---------------------------------------------------------------------------
// Impor dari screenshot (daftar transaksi dari app lain) — pakai Gemini
// ---------------------------------------------------------------------------

function impKey(uid) {
  return `imp:${uid}`;
}

async function handleImportStart(env, chatId, uid) {
  if (!env.GEMINI_API_KEY) {
    return sendMessage(env, chatId, "Impor screenshot butuh Gemini (GEMINI_API_KEY) karena harus baca banyak baris. Set dulu di Worker ya.", BACK_MENU);
  }
  await setMode(env, uid, "impor");
  return sendMessage(
    env,
    chatId,
    "🖼️ Kirim SATU screenshot daftar transaksi dari app lamamu.\nAku baca semua barisnya, tampilkan preview, baru kamu konfirmasi.\n(Riwayat panjang? kirim beberapa SS satu per satu.)",
    BACK_MENU,
  );
}

const IMPORT_PROMPT =
  "Ini screenshot DAFTAR transaksi keuangan dari aplikasi. Ekstrak SEMUA baris transaksi yang terlihat. " +
  "Untuk tiap baris tentukan: jenis 'masuk' (pemasukan/income) atau 'keluar' (pengeluaran/expense) — " +
  "biasanya pemasukan berwarna hijau/plus, pengeluaran merah/minus; " +
  "jumlah = angka rupiah hanya digit tanpa titik/koma; " +
  "keterangan = nama/kategori transaksi; " +
  "tanggal = format DD-MM-YYYY bila terbaca, kalau tidak ada kosongkan. " +
  "Jangan mengarang baris yang tidak ada. Balas JSON.";

async function handleImportScreenshot(env, chatId, msg) {
  const uid = msg.from.id;
  if (!env.GEMINI_API_KEY) {
    return sendMessage(env, chatId, "Impor screenshot butuh GEMINI_API_KEY.", BACK_MENU);
  }
  await sendMessage(env, chatId, "🔎 Membaca screenshot...");
  const photo = msg.photo[msg.photo.length - 1];
  const bytes = await getTelegramFile(env, photo.file_id);

  const res = await extractTransactionsGemini(env, bytes);
  if (!res.ok || !res.rows.length) {
    const why = res.debug ? `\n\n(debug: ${res.debug})` : "";
    return sendMessage(env, chatId, "Tidak ada transaksi terbaca dari gambar. Coba SS lebih jelas." + why, BACK_MENU);
  }

  // Normalisasi + simpan sementara.
  const rows = res.rows.slice(0, 200).map((r) => {
    const kind = /masuk|income|pemasukan|\+/i.test(String(r.jenis)) ? "masuk" : "keluar";
    const amount = Math.round(Number(String(r.jumlah).replace(/[^\d]/g, "")) || 0);
    const note = (r.keterangan || "").toString().trim() || "(impor)";
    const ts = parseAnyDate(r.tanggal || "") || 0;
    return { kind, amount, note, ts };
  }).filter((r) => r.amount > 0);

  if (!rows.length) return sendMessage(env, chatId, "Baris terbaca tapi nominalnya kosong. Coba SS lebih jelas.", BACK_MENU);

  await env.EXPENSES.put(impKey(uid), JSON.stringify(rows), { expirationTtl: 900 });

  let masuk = 0, keluar = 0;
  for (const r of rows) (r.kind === "masuk" ? (masuk += r.amount) : (keluar += r.amount));
  const preview = rows.slice(0, 15).map((r) => {
    const ic = r.kind === "masuk" ? "🟢" : "🔴";
    const tg = r.ts ? tglPendek(r.ts) : "-";
    return `${ic} ${tg} · ${fmtRp(r.amount)} — ${r.note}`;
  });
  const lines = [
    `📋 Terbaca ${rows.length} transaksi:`,
    "",
    ...preview,
    rows.length > 15 ? `… dan ${rows.length - 15} lagi` : "",
    "",
    `🟢 Masuk: ${fmtRp(masuk)}  🔴 Keluar: ${fmtRp(keluar)}`,
    "",
    "Simpan semua? (yang tanpa tanggal dipakai hari ini)",
  ].filter((x) => x !== "");
  return sendMessage(env, chatId, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: [[{ text: `✅ Simpan ${rows.length} transaksi`, callback_data: "doimport" }], [{ text: "Batal", callback_data: "menu" }]],
    },
  });
}

async function doImport(env, chatId, uid) {
  const raw = await env.EXPENSES.get(impKey(uid));
  if (!raw) return sendMessage(env, chatId, "Data impor tidak ada / kadaluarsa. Kirim ulang screenshot-nya.", BACK_MENU);
  const rows = JSON.parse(raw);
  const list = await getEntries(env, uid);
  const cfg = await getConfig(env, uid);
  for (const r of rows) {
    list.push({
      ts: r.ts || Date.now(),
      kind: r.kind,
      amount: r.amount,
      note: r.note,
      category: r.kind === "keluar" ? categorize(r.note) : "",
      party: "",
      status: "",
      wallet: cfg.defaultWallet,
      from: "",
      to: "",
      src: "impor",
    });
  }
  await saveEntries(env, uid, list);
  await env.EXPENSES.delete(impKey(uid));
  return sendMessage(env, chatId, `✅ ${rows.length} transaksi diimpor.`, BACK_MENU);
}

async function extractTransactionsGemini(env, arrayBuffer) {
  const model = (env.GEMINI_MODEL || "gemini-3.6-flash").trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: IMPORT_PROMPT }, { inline_data: { mime_type: "image/jpeg", data: abToBase64(arrayBuffer) } }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          transaksi: {
            type: "array",
            items: {
              type: "object",
              properties: {
                tanggal: { type: "string" },
                jenis: { type: "string" },
                jumlah: { type: "integer" },
                keterangan: { type: "string" },
              },
              required: ["jenis", "jumlah", "keterangan"],
            },
          },
        },
        required: ["transaksi"],
      },
    },
  };
  let status = 0, bodyText = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetchWithTimeout(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 60000);
      status = r.status;
      bodyText = await r.text();
    } catch (e) {
      await sleep(1200 * attempt);
      continue;
    }
    const transient = status === 429 || status >= 500 || /high demand|overloaded|unavailable|try again/i.test(bodyText);
    if (transient && attempt < 3) { await sleep(1200 * attempt); continue; }
    break;
  }
  let j;
  try { j = JSON.parse(bodyText); } catch { return { ok: false, rows: [], debug: `HTTP ${status}: ${bodyText.slice(0, 120)}` }; }
  if (status !== 200 || j.error) return { ok: false, rows: [], debug: (j.error && j.error.message) || `HTTP ${status}` };
  const cand = j.candidates && j.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  const text = (parts || []).map((p) => p.text || "").join("");
  try {
    const obj = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
    return { ok: true, rows: Array.isArray(obj.transaksi) ? obj.transaksi : [] };
  } catch {
    return { ok: false, rows: [], debug: "balasan bukan JSON" };
  }
}

// Parse tanggal fleksibel: DD-MM-YYYY, DD/MM/YYYY, "15 Sep 2026". -> ts (WIB) atau 0.
function parseAnyDate(s) {
  s = String(s || "").trim();
  if (!s) return 0;
  let m = s.match(/(\d{1,2})[-/ ](\d{1,2})[-/ ](\d{2,4})/);
  if (m) {
    let [_, d, mo, y] = m;
    d = +d; mo = +mo; y = +y;
    if (y < 100) y += 2000;
    if (d > 31 || mo > 12) return 0;
    return Date.UTC(y, mo - 1, d, 12) - WIB_OFFSET_MS;
  }
  m = s.match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  if (m) {
    const bulan = ["jan", "feb", "mar", "apr", "mei", "may", "jun", "jul", "agu", "aug", "sep", "okt", "oct", "nov", "des", "dec"];
    const idx = { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, agu: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 };
    const key = m[2].slice(0, 3).toLowerCase();
    if (idx[key]) return Date.UTC(+m[3], idx[key] - 1, +m[1], 12) - WIB_OFFSET_MS;
  }
  return 0;
}

// /ai            -> status mesin baca struk + tombol
// /ai on | off   -> pakai Gemini (on) atau Workers AI (off)
async function handleAi(env, chatId, uid, arg) {
  const cfg = await getConfig(env, uid);
  const a = arg.toLowerCase();

  if (a === "on" || a === "gemini") {
    if (!env.GEMINI_API_KEY) return sendMessage(env, chatId, "GEMINI_API_KEY belum diset di Worker.", BACK_MENU);
    cfg.useGemini = true;
    await saveConfig(env, uid, cfg);
    return sendMessage(env, chatId, "🤖 Mesin baca struk: Gemini (akurat).", BACK_MENU);
  }
  if (a === "off" || a === "workers" || a === "cf") {
    cfg.useGemini = false;
    await saveConfig(env, uid, cfg);
    return sendMessage(env, chatId, "🤖 Mesin baca struk: Workers AI (data tetap di Cloudflare).", BACK_MENU);
  }

  const aktif = cfg.useGemini && env.GEMINI_API_KEY ? "Gemini" : "Workers AI";
  const punyaGemini = env.GEMINI_API_KEY ? "ada" : "belum diset";
  const rows = [
    [
      { text: "🤖 Gemini (akurat)", callback_data: "ai_on" },
      { text: "☁️ Workers AI (privat)", callback_data: "ai_off" },
    ],
    [BACK_BTN],
  ];
  return sendMessage(
    env,
    chatId,
    `Mesin baca struk saat ini: ${aktif}.\nGEMINI_API_KEY: ${punyaGemini}.\n\n• Gemini: lebih akurat, tapi data struk bisa dipakai Google (free tier).\n• Workers AI: kurang akurat, tapi data tetap di Cloudflare.`,
    { reply_markup: { inline_keyboard: rows } },
  );
}

// Terima file .json -> validasi -> minta konfirmasi sebelum menimpa.
async function handleRestoreUpload(env, chatId, msg) {
  const uid = msg.from.id;
  const doc = msg.document;
  const name = (doc.file_name || "").toLowerCase();
  const isJson = name.endsWith(".json") || doc.mime_type === "application/json";
  if (!isJson) {
    return sendMessage(env, chatId, "Untuk memulihkan, kirim file backup berformat .json.", BACK_MENU);
  }
  let data;
  try {
    const buf = await getTelegramFile(env, doc.file_id);
    data = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return sendMessage(env, chatId, "File tidak bisa dibaca / bukan JSON valid.", BACK_MENU);
  }
  const entries = Array.isArray(data) ? data : data.entries;
  if (!Array.isArray(entries)) {
    return sendMessage(env, chatId, "Format backup tidak dikenali.", BACK_MENU);
  }
  // Simpan sementara (15 menit) sampai user konfirmasi.
  await env.EXPENSES.put(rstKey(uid), JSON.stringify({ entries, config: (data && data.config) || null }), { expirationTtl: 900 });
  const cur = (await getEntries(env, uid)).length;
  return sendMessage(
    env,
    chatId,
    `📥 Backup berisi ${entries.length} catatan.\nData saat ini: ${cur} catatan.\n\n⚠️ Memulihkan akan MENIMPA semua data sekarang.`,
    { reply_markup: { inline_keyboard: [[{ text: "✅ Pulihkan (timpa semua)", callback_data: "dorestore" }], [{ text: "Batal", callback_data: "menu" }]] } },
  );
}

async function doRestore(env, chatId, uid) {
  const raw = await env.EXPENSES.get(rstKey(uid));
  if (!raw) return sendMessage(env, chatId, "Data restore tidak ada / kadaluarsa. Kirim ulang file backup-nya.", BACK_MENU);
  const obj = JSON.parse(raw);
  await saveEntries(env, uid, obj.entries);
  if (obj.config) await saveConfig(env, uid, obj.config);
  await env.EXPENSES.delete(rstKey(uid));
  return sendMessage(env, chatId, `✅ Data dipulihkan: ${obj.entries.length} catatan.`, BACK_MENU);
}

// Susun workbook: satu sheet per bulan (kronologis), saldo berjalan menyambung.
function buildExcel(list, cfg) {
  const sorted = [...list].sort((a, b) => a.ts - b.ts);
  const months = []; // { key, name, entries }
  const byKey = {};
  for (const e of sorted) {
    const p = wibParts(e.ts);
    const key = p.y * 100 + p.m;
    if (!byKey[key]) {
      byKey[key] = { key, name: `${NAMA_BULAN[p.m - 1]} ${p.y}`, entries: [] };
      months.push(byKey[key]);
    }
    byKey[key].entries.push(e);
  }

  const HEAD = ["Tanggal", "Waktu", "Jenis", "Masuk", "Keluar", "Saldo", "Kategori", "Keterangan", "Pihak", "Dompet", "Status"];
  const hrow = () => HEAD.map((h) => ({ v: h, s: 1 }));
  let saldo = 0;
  const rekap = []; // { name, masuk, keluar } per bulan untuk sheet Ringkasan
  const monthSheets = months.map((m) => {
    const rows = [];
    rows.push(hrow());
    rows.push([e5(), e5(), bcell("Saldo awal"), e5(), e5(), numS(saldo), e5(), e5(), e5(), e5(), e5()]);
    let tMasuk = 0, tKeluar = 0;
    for (const e of m.entries) {
      const d = new Date(e.ts + WIB_OFFSET_MS);
      let masukN = e5(), keluarN = e5();
      if (e.kind === "masuk") { saldo += e.amount; tMasuk += e.amount; masukN = numG(e.amount); }
      else if (e.kind === "keluar") { saldo -= e.amount; tKeluar += e.amount; keluarN = numR(e.amount); }
      else if (e.kind === "mutasi") {
        if (e.to && !e.from) { saldo += e.amount; masukN = numG(e.amount); }
        else if (e.from && !e.to) { saldo -= e.amount; keluarN = numR(e.amount); }
      }
      const dompet = e.kind === "mutasi" ? `${e.from || ""}→${e.to || ""}` : e.wallet || "";
      rows.push([
        cell(`${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`),
        cell(`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`),
        cell(e.kind),
        masukN, keluarN, numS(saldo),
        cell(e.category || ""), cell(e.note || ""), cell(e.party || ""), cell(dompet), cell(e.status || ""),
      ]);
    }
    rows.push([tlabel(""), tlabel(""), tlabel("TOTAL"), numT(tMasuk), numT(tKeluar), numT(saldo), tlabel(""), tlabel(""), tlabel(""), tlabel(""), tlabel("")]);
    rekap.push({ name: m.name, masuk: tMasuk, keluar: tKeluar });
    return { name: m.name.slice(0, 31), rows, opts: { freeze: true, filterRef: `A1:K${rows.length}` } };
  });

  // Sheet "Ringkasan" (paling depan): rekap semua bulan + total + saldo akhir.
  const sRows = [];
  sRows.push(["Bulan", "Masuk", "Keluar", "Selisih"].map((h) => ({ v: h, s: 1 })));
  let gM = 0, gK = 0;
  for (const r of rekap) {
    gM += r.masuk; gK += r.keluar;
    sRows.push([cell(r.name), numG(r.masuk), numR(r.keluar), numS(r.masuk - r.keluar)]);
  }
  sRows.push([tlabel("TOTAL"), numT(gM), numT(gK), numT(gM - gK)]);
  sRows.push([]);
  sRows.push([bcell("Saldo akhir (semua dompet)"), e5(), e5(), numT(saldo)]);

  // Hutang/piutang belum lunas — terpisah, TIDAK dicampur ke Masuk/Keluar.
  let openH = 0, openP = 0;
  for (const e of list) {
    if (e.kind === "hutang" && e.status === "belum") openH += e.amount;
    if (e.kind === "piutang" && e.status === "belum") openP += e.amount;
  }
  if (openH || openP) {
    sRows.push([]);
    sRows.push([{ v: "Belum lunas (di luar arus kas)", s: 1 }, { v: "", s: 1 }, { v: "", s: 1 }, { v: "", s: 1 }]);
    sRows.push([cell("Hutang (kamu pinjam)"), e5(), e5(), numR(openH)]);
    sRows.push([cell("Piutang (orang pinjam)"), e5(), e5(), numG(openP)]);
  }
  const summarySheet = { name: "Ringkasan", rows: sRows, opts: { freeze: true } };

  if (!monthSheets.length) return xlsxPackage([summarySheet]);
  return xlsxPackage([summarySheet, ...monthSheets]);
}

// Helper sel (semua bergaris supaya rapi seperti laporan)
function cell(v) { return { v: v == null ? "" : String(v), s: 5 }; }   // teks
function bcell(v) { return { v: v == null ? "" : String(v), s: 4 }; }  // teks tebal
function e5() { return { v: "", s: 5 }; }                              // kosong bergaris
function num(n) { return { v: Math.round(n), t: "n", s: 2 }; }         // rupiah
function numG(n) { return { v: Math.round(n), t: "n", s: 6 }; }        // rupiah hijau (masuk)
function numR(n) { return { v: Math.round(n), t: "n", s: 7 }; }        // rupiah merah (keluar)
function numS(n) { return { v: Math.round(n), t: "n", s: 8 }; }        // rupiah saldo (biru)
function numT(n) { return { v: Math.round(n), t: "n", s: 10 }; }       // rupiah total (arsir)
function tlabel(v) { return { v: v == null ? "" : String(v), s: 9 }; } // sel baris total

// --- XLSX / ZIP internals ---
const XLSX_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u) {
  let c = 0xffffffff;
  for (let i = 0; i < u.length; i++) c = XLSX_CRC[(c ^ u[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function enc(s) { return new TextEncoder().encode(s); }
function xesc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}
function colLetter(n) {
  let s = "";
  n++;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}
function cellXml(ref, c) {
  if (!c || c.v === "" || c.v == null) return `<c r="${ref}"${c && c.s ? ` s="${c.s}"` : ""}/>`;
  if (c.t === "n") return `<c r="${ref}" s="${c.s || 0}"><v>${c.v}</v></c>`;
  return `<c r="${ref}" s="${c.s || 0}" t="inlineStr"><is><t xml:space="preserve">${xesc(c.v)}</t></is></c>`;
}
function sheetXml(rows, opts = {}) {
  let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  x += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
  let maxc = 1;
  for (const r of rows) if (r.length > maxc) maxc = r.length;
  x += `<dimension ref="A1:${colLetter(maxc - 1)}${rows.length || 1}"/>`;
  // Sembunyikan gridline bawaan (pakai border sel) + bekukan baris header.
  x += '<sheetViews><sheetView showGridLines="0" workbookViewId="0">';
  if (opts.freeze) {
    x += '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>';
    x += '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';
  }
  x += "</sheetView></sheetViews>";
  x += '<sheetFormatPr defaultRowHeight="15"/>';
  x += '<cols><col min="1" max="1" width="11"/><col min="2" max="2" width="7"/><col min="3" max="3" width="9"/><col min="4" max="6" width="15"/><col min="7" max="8" width="18"/><col min="9" max="11" width="12"/></cols>';
  x += "<sheetData>";
  rows.forEach((cells, ri) => {
    const ht = ri === 0 ? ' ht="22" customHeight="1"' : "";
    x += `<row r="${ri + 1}"${ht}>`;
    cells.forEach((c, ci) => { x += cellXml(colLetter(ci) + (ri + 1), c); });
    x += "</row>";
  });
  x += "</sheetData>";
  if (opts.filterRef) x += `<autoFilter ref="${opts.filterRef}"/>`;
  x += "</worksheet>";
  return x;
}
const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;Rp&quot;#,##0;[Red]&quot;Rp&quot;-#,##0"/></numFmts>' +
  '<fonts count="6">' +
  '<font><sz val="11"/><name val="Calibri"/></font>' +                                             // 0 default
  '<font><b/><sz val="11"/><name val="Calibri"/></font>' +                                          // 1 bold
  '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +                   // 2 bold putih
  '<font><b/><sz val="11"/><color rgb="FF137333"/><name val="Calibri"/></font>' +                   // 3 hijau
  '<font><b/><sz val="11"/><color rgb="FFC5221F"/><name val="Calibri"/></font>' +                   // 4 merah
  '<font><b/><sz val="11"/><color rgb="FF1F3A5F"/><name val="Calibri"/></font>' +                   // 5 biru
  "</fonts>" +
  '<fills count="4">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/><bgColor indexed="64"/></patternFill></fill>' + // 2 header
  '<fill><patternFill patternType="solid"><fgColor rgb="FFEFF2F6"/><bgColor indexed="64"/></patternFill></fill>' + // 3 total
  "</fills>" +
  '<borders count="2">' +
  '<border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left style="thin"><color rgb="FFD9DDE3"/></left><right style="thin"><color rgb="FFD9DDE3"/></right><top style="thin"><color rgb="FFD9DDE3"/></top><bottom style="thin"><color rgb="FFD9DDE3"/></bottom><diagonal/></border>' +
  "</borders>" +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="11">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +                                                                                             // 0 default
  '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' + // 1 header
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>' +                                                     // 2 rupiah
  '<xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' +                                       // 3 rupiah bold
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>' +                                                               // 4 teks bold
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>' +                                                                             // 5 teks
  '<xf numFmtId="164" fontId="3" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' +                                       // 6 rupiah hijau
  '<xf numFmtId="164" fontId="4" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' +                                       // 7 rupiah merah
  '<xf numFmtId="164" fontId="5" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' +                                       // 8 rupiah saldo (biru)
  '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +                                                 // 9 total label
  '<xf numFmtId="164" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>' +                         // 10 total rupiah
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

function xlsxPackage(sheets) {
  const files = [];
  // [Content_Types].xml
  let ct =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
  sheets.forEach((_, i) => {
    ct += `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  });
  ct += "</Types>";
  files.push({ name: "[Content_Types].xml", data: enc(ct) });

  // _rels/.rels
  files.push({
    name: "_rels/.rels",
    data: enc(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    ),
  });

  // xl/workbook.xml
  let wb =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>';
  sheets.forEach((s, i) => {
    const nm = xesc(s.name.slice(0, 31).replace(/[:\\/?*\[\]]/g, " "));
    wb += `<sheet name="${nm}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`;
  });
  wb += "</sheets></workbook>";
  files.push({ name: "xl/workbook.xml", data: enc(wb) });

  // xl/_rels/workbook.xml.rels
  let rel =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  sheets.forEach((_, i) => {
    rel += `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`;
  });
  rel += `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  rel += "</Relationships>";
  files.push({ name: "xl/_rels/workbook.xml.rels", data: enc(rel) });

  // styles + sheets
  files.push({ name: "xl/styles.xml", data: enc(STYLES_XML) });
  sheets.forEach((s, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc(sheetXml(s.rows, s.opts || {})) });
  });

  return zipStore(files);
}

// ZIP tanpa kompresi (stored) — cukup untuk XLSX.
function zipStore(files) {
  const infos = files.map((f) => ({ nameB: enc(f.name), data: f.data, crc: crc32(f.data) }));
  let size = 22;
  for (const i of infos) size += 30 + i.nameB.length + i.data.length + 46 + i.nameB.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let off = 0;
  const dir = [];
  for (const i of infos) {
    const localOff = off;
    dv.setUint32(off, 0x04034b50, true); off += 4;
    dv.setUint16(off, 20, true); off += 2;
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint32(off, i.crc, true); off += 4;
    dv.setUint32(off, i.data.length, true); off += 4;
    dv.setUint32(off, i.data.length, true); off += 4;
    dv.setUint16(off, i.nameB.length, true); off += 2;
    dv.setUint16(off, 0, true); off += 2;
    out.set(i.nameB, off); off += i.nameB.length;
    out.set(i.data, off); off += i.data.length;
    dir.push({ ...i, localOff });
  }
  const cdStart = off;
  for (const i of dir) {
    dv.setUint32(off, 0x02014b50, true); off += 4;
    dv.setUint16(off, 20, true); off += 2;
    dv.setUint16(off, 20, true); off += 2;
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint32(off, i.crc, true); off += 4;
    dv.setUint32(off, i.data.length, true); off += 4;
    dv.setUint32(off, i.data.length, true); off += 4;
    dv.setUint16(off, i.nameB.length, true); off += 2;
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint16(off, 0, true); off += 2;
    dv.setUint32(off, 0, true); off += 4;
    dv.setUint32(off, i.localOff, true); off += 4;
    out.set(i.nameB, off); off += i.nameB.length;
  }
  const cdSize = off - cdStart;
  dv.setUint32(off, 0x06054b50, true); off += 4;
  dv.setUint16(off, 0, true); off += 2;
  dv.setUint16(off, 0, true); off += 2;
  dv.setUint16(off, dir.length, true); off += 2;
  dv.setUint16(off, dir.length, true); off += 2;
  dv.setUint32(off, cdSize, true); off += 4;
  dv.setUint32(off, cdStart, true); off += 4;
  dv.setUint16(off, 0, true); off += 2;
  return out;
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

async function doHapusAll(env, chatId, uid, markup) {
  const list = await getEntries(env, uid);
  const n = list.length;
  await saveEntries(env, uid, []);
  return sendMessage(env, chatId, `🗑️ Semua catatan dihapus (${n} entri).`, markup);
}

async function deleteLast(env, chatId, uid, markup) {
  const list = await getEntries(env, uid);
  if (!list.length) return sendMessage(env, chatId, "Tidak ada catatan untuk dihapus.", markup);
  const last = list.pop();
  await saveEntries(env, uid, list);
  return sendMessage(env, chatId, `🗑️ Dihapus: ${entryIcon(last)} ${fmtRp(last.amount)} — ${last.note}`, markup);
}

// ---------------------------------------------------------------------------
// Edit catatan (pilih dari daftar, lalu ubah/hapus)
// ---------------------------------------------------------------------------

function entryIcon(e) {
  if (e.kind === "masuk") return "🟢";
  if (e.kind === "keluar") return "🔴";
  if (e.kind === "hutang") return "📕";
  if (e.kind === "piutang") return "📗";
  if (e.kind === "mutasi") return "💵";
  return "•";
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
  const wlt = e.wallet ? ` (${e.wallet})` : "";
  const info = `${entryIcon(e)} ${fmtRp(e.amount)} — ${e.note}${e.party ? " / " + e.party : ""}${wlt}\n🗓️ ${tglPendek(e.ts)} · ${jamPendek(e.ts)}`;
  const rows = [
    [
      { text: "✏️ Nominal", callback_data: `ea:${ts}` },
      { text: "📝 Keterangan", callback_data: `en:${ts}` },
    ],
  ];
  if (e.kind === "keluar" || e.kind === "masuk") rows.push([{ text: "👛 Dompet", callback_data: `ewp:${ts}` }]);
  rows.push([{ text: "🗑️ Hapus", callback_data: `del:${ts}` }]);
  rows.push([{ text: "🔙 Daftar", callback_data: "edit" }, BACK_BTN]);
  return sendMessage(env, chatId, `Edit:\n${info}`, { reply_markup: { inline_keyboard: rows } });
}

// Pilih dompet untuk sebuah catatan (termasuk "Tanpa dompet").
async function sendEntryWalletPicker(env, chatId, uid, ts) {
  const cfg = await getConfig(env, uid);
  const rows = chunk(cfg.wallets.map((w, i) => ({ text: w, callback_data: `ew:${ts}:${i}` })), 2);
  rows.push([{ text: "⭐ Default (" + cfg.defaultWallet + ")", callback_data: `ew:${ts}:-1` }]);
  rows.push([{ text: "🚫 Tanpa dompet (tak ubah saldo)", callback_data: `ew:${ts}:-2` }]);
  rows.push([{ text: "🔙 Batal", callback_data: `edit:${ts}` }]);
  return sendMessage(env, chatId, "👛 Catat pakai dompet mana?", kb(rows));
}
async function setEntryWallet(env, chatId, uid, ts, walletIdx) {
  const cfg = await getConfig(env, uid);
  const wallet = walletIdx === -2 ? NO_WALLET : (walletIdx < 0 ? cfg.defaultWallet : (cfg.wallets[walletIdx] || cfg.defaultWallet));
  const list = await getEntries(env, uid);
  const idx = list.findIndex((x) => x.ts === ts);
  if (idx === -1) return sendMessage(env, chatId, "Catatan tidak ditemukan.", BACK_MENU);
  list[idx].wallet = wallet;
  await saveEntries(env, uid, list);
  return sendEditOptions(env, chatId, uid, ts);
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

// ---------------------------------------------------------------------------
// Dompet (wallet) & saldo
// ---------------------------------------------------------------------------

async function sendSaldo(env, chatId, uid, markup) {
  const [list, cfg] = await Promise.all([getEntries(env, uid), getConfig(env, uid)]);
  const bal = walletBalances(list, cfg);
  const lines = ["👛 Saldo per dompet:", ""];
  let total = 0;
  for (const w of cfg.wallets) {
    total += bal[w] || 0;
    lines.push(`• ${w}: ${fmtRp(bal[w] || 0)}`);
  }
  // dompet lain yang muncul dari data lama tapi tak terdaftar
  for (const w of Object.keys(bal)) {
    if (!cfg.wallets.includes(w)) {
      total += bal[w];
      lines.push(`• ${w}: ${fmtRp(bal[w])} (tak terdaftar)`);
    }
  }
  lines.push("", `💰 Total: ${fmtRp(total)}`);
  lines.push("", "Catat ke dompet tertentu: tambah @nama, mis '50rb makan @cash'");
  return sendMessage(env, chatId, lines.join("\n"), markup || BACK_MENU);
}

// /dompet                 -> daftar dompet + saldo
// /dompet tambah GoPay    -> tambah dompet
// /dompet hapus GoPay     -> hapus dompet
// /dompet utama Bank      -> set dompet default
async function handleDompet(env, chatId, uid, arg) {
  const cfg = await getConfig(env, uid);
  const parts = arg.split(/\s+/).filter(Boolean);
  const cmd = (parts.shift() || "").toLowerCase();
  const name = parts.join(" ").trim();

  if (cmd === "tambah" || cmd === "add") {
    if (!name) return sendMessage(env, chatId, "Nama dompet? Contoh: /dompet tambah GoPay", BACK_MENU);
    if (cfg.wallets.some((w) => w.toLowerCase() === name.toLowerCase())) {
      return sendMessage(env, chatId, `Dompet "${name}" sudah ada.`, BACK_MENU);
    }
    cfg.wallets.push(name);
    await saveConfig(env, uid, cfg);
    return sendMessage(env, chatId, `✅ Dompet ditambah: ${name}\nSekarang: ${cfg.wallets.join(", ")}`, BACK_MENU);
  }
  if (cmd === "hapus" || cmd === "del") {
    const w = resolveWallet(name, cfg);
    if (!w) return sendMessage(env, chatId, `Dompet "${name}" tidak ada.`, BACK_MENU);
    cfg.wallets = cfg.wallets.filter((x) => x !== w);
    if (cfg.defaultWallet === w) cfg.defaultWallet = cfg.wallets[0] || "Cash";
    await saveConfig(env, uid, cfg);
    return sendMessage(env, chatId, `🗑️ Dompet dihapus: ${w}\n(catatan lama tetap tersimpan)`, BACK_MENU);
  }
  if (cmd === "utama" || cmd === "default") {
    const w = resolveWallet(name, cfg);
    if (!w) return sendMessage(env, chatId, `Dompet "${name}" tidak ada.`, BACK_MENU);
    cfg.defaultWallet = w;
    await saveConfig(env, uid, cfg);
    return sendMessage(env, chatId, `✅ Dompet utama: ${w}`, BACK_MENU);
  }
  if (cmd === "saldo" || cmd === "set" || cmd === "isi") {
    const toks = name.split(/\s+/).filter(Boolean);
    const w = resolveWallet(toks.shift() || "", cfg);
    if (!w) return sendMessage(env, chatId, `Format: /dompet saldo <nama> <jumlah>\nDompet: ${cfg.wallets.join(", ")}`, BACK_MENU);
    const p = parseAmountToken(toks.join(" "));
    if (!p) return sendMessage(env, chatId, "Jumlah tak terbaca. Contoh: /dompet saldo Bank 5jt", BACK_MENU);
    const bal = walletBalances(await getEntries(env, uid), cfg);
    const diff = p.amount - (bal[w] || 0);
    if (diff === 0) return sendMessage(env, chatId, `Saldo ${w} sudah ${fmtRp(p.amount)}.`, BACK_MENU);
    // Penyesuaian sebagai mutasi (tidak masuk pemasukan/pengeluaran).
    if (diff > 0) await addEntry(env, uid, { kind: "mutasi", amount: diff, from: "", to: w, note: "set saldo awal" });
    else await addEntry(env, uid, { kind: "mutasi", amount: -diff, from: w, to: "", note: "set saldo awal" });
    return sendMessage(env, chatId, `✅ Saldo ${w} diset ke ${fmtRp(p.amount)}`, BACK_MENU);
  }

  // tampilkan info + saldo
  const bal = walletBalances(await getEntries(env, uid), cfg);
  const lines = ["👛 Dompet:", ""];
  for (const w of cfg.wallets) {
    const utama = w === cfg.defaultWallet ? " ⭐" : "";
    lines.push(`• ${w}: ${fmtRp(bal[w] || 0)}${utama}`);
  }
  lines.push(
    "",
    "Kelola:",
    "/dompet tambah GoPay",
    "/dompet hapus GoPay",
    "/dompet utama Bank",
    "/dompet saldo Bank 5jt  (set saldo awal)",
    "",
    "Pakai: '50rb makan @gopay' · pindah: 'pindah 200rb bank cash'",
  );
  return sendMessage(env, chatId, lines.join("\n"), BACK_MENU);
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
    "🧾 BOT CATATAN KEUANGAN",
    "Tekan /menu untuk tombol cepat (tap → langsung ketik angkanya).",
    "",
    "━ MENCATAT ━",
    "🔴 Pengeluaran : 50rb makan siang   (atau -50rb makan)",
    "🟢 Pemasukan   : +5jt gaji           (awali +)",
    "💵 Tarik tunai : tarik 500rb         (Bank→Cash, bukan pengeluaran)",
    "🧾 Foto struk  : kirim fotonya (dibaca AI → pengeluaran)",
    "🖼️ Impor SS   : /impor lalu kirim screenshot daftar transaksi app lain",
    "",
    "Opsi tambahan saat mencatat:",
    "• Dompet   : @nama   → 50rb makan @gopay",
    "• Tanggal  : tgl DD-MM-YYYY [jam HH:MM] → 50rb makan tgl 15-3-2025 14:30",
    "• Kategori : otomatis; paksa dgn #tag → 100rb #arisan",
    "• Caption foto: 'piutang andi' / 'hutang budi' / 'tarik' / 'masuk'",
    "",
    "━ HUTANG / PIUTANG ━",
    "/hutang 100rb budi bensin   (kamu pinjam ke orang)",
    "/piutang 50rb ani           (orang pinjam ke kamu)",
    "  bisa +tanggal: ... tgl 15-3-2025",
    "/utang   — rekap hutang & piutang",
    "/lunas   — lihat & lunasi (tap tombol)",
    "",
    "━ DOMPET ━",
    "/saldo   — saldo tiap dompet",
    "/dompet  — kelola dompet",
    "   /dompet tambah GoPay",
    "   /dompet hapus GoPay",
    "   /dompet utama Bank",
    "   /dompet saldo Bank 5jt   (set saldo awal)",
    "/pindah 200rb bank gopay — transfer antar dompet",
    "",
    "━ BUDGET ━",
    "/budget 3jt — set batas bulanan (auto-warning)",
    "/budget     — lihat sisa budget",
    "",
    "━ LAPORAN & DATA ━",
    "/laporan          — rekap hari & bulan ini",
    "/laporan agustus  — laporan bulan tertentu",
    "/grafik           — grafik pai per kategori",
    "/cari grab        — cari transaksi",
    "/total            — total sepanjang waktu",
    "/excel            — unduh Excel (per bulan, format Rp)",
    "/export           — unduh CSV",
    "/hari             — tanggal & hari sekarang",
    "",
    "━ KELOLA CATATAN ━",
    "/edit    — pilih catatan → ubah/hapus",
    "/hapus   — hapus catatan terakhir",
    "/hapusall — hapus semua (perlu konfirmasi)",
    "",
    "━ BACKUP & AI ━",
    "/backup  — unduh file backup .json",
    "/restore — kirim file .json untuk memulihkan",
    "/ai      — pilih mesin baca struk (Gemini/Workers AI)",
    "",
    "ℹ️ Rekap bulan lalu dikirim otomatis tiap awal bulan.",
  ].join("\n");
}

// Tombol balik ke menu utama (ditempel di tiap hasil).
const BACK_BTN = { text: "🔙 Menu", callback_data: "menu" };
const BACK_MENU = { reply_markup: { inline_keyboard: [[BACK_BTN]] } };

// Menu utama: aksi cepat di atas, lalu kategori.
const MENU_MAIN = {
  reply_markup: {
    inline_keyboard: [
      // Aksi tercepat (1 tap)
      [
        { text: "🔴 Keluar", callback_data: "add_keluar" },
        { text: "🟢 Masuk", callback_data: "add_masuk" },
      ],
      [
        { text: "📊 Laporan", callback_data: "laporan" },
        { text: "👛 Saldo", callback_data: "saldo" },
      ],
      // Kategori (buka submenu)
      [
        { text: "➕ Catat lainnya", callback_data: "cat_catat" },
        { text: "📈 Laporan & data", callback_data: "cat_laporan" },
      ],
      [
        { text: "📋 Hutang/Piutang", callback_data: "cat_utang" },
        { text: "💼 Dompet", callback_data: "cat_dompet" },
      ],
      [
        { text: "🎯 Budget", callback_data: "cat_budget" },
        { text: "🧰 Lainnya", callback_data: "cat_lain" },
      ],
      [{ text: "❓ Bantuan", callback_data: "help" }],
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
      [{ text: "💵 Tarik tunai", callback_data: "add_mutasi" }],
      [{ text: "🖼️ Impor dari screenshot", callback_data: "impor" }],
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
        { text: "📊 Excel (per bulan)", callback_data: "excel" },
        { text: "📄 CSV", callback_data: "export" },
      ],
      [
        { text: "💰 Total", callback_data: "total" },
        { text: "🔍 Cari", callback_data: "cari" },
      ],
      [
        { text: "📅 Laporan bulan lain", callback_data: "lap_pick" },
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
    inline_keyboard: [
      [{ text: "🎯 Lihat budget", callback_data: "budget" }],
      [
        { text: "✏️ Set budget", callback_data: "budget_set" },
        { text: "❌ Matikan", callback_data: "budget_off" },
      ],
      [BACK_BTN],
    ],
  },
};
const MENU_DOMPET = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "👛 Saldo", callback_data: "saldo" },
        { text: "⚙️ Kelola", callback_data: "dompet" },
      ],
      [
        { text: "💵 Tarik tunai", callback_data: "add_mutasi" },
        { text: "🔁 Pindah", callback_data: "add_pindah" },
      ],
      [{ text: "💼 Set saldo awal", callback_data: "add_setsaldo" }],
      [BACK_BTN],
    ],
  },
};
const MENU_LAIN = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "✏️ Edit catatan", callback_data: "edit" },
        { text: "🗑️ Hapus terakhir", callback_data: "del_last" },
      ],
      [
        { text: "🗑️ Hapus semua", callback_data: "del_all" },
        { text: "🤖 Mesin AI", callback_data: "ai" },
      ],
      [
        { text: "🗂️ Backup", callback_data: "backup" },
        { text: "📥 Restore", callback_data: "restore" },
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

// ---------------------------------------------------------------------------
// Alur berbasis tombol (minim ketik): pindah, set saldo, tarik, budget, dompet
// ---------------------------------------------------------------------------

const CASH_PRESET = [["10rb", 10000], ["20rb", 20000], ["50rb", 50000], ["100rb", 100000], ["200rb", 200000], ["500rb", 500000]];
const BIG_PRESET = [["500rb", 500000], ["1jt", 1000000], ["2jt", 2000000], ["3jt", 3000000], ["5jt", 5000000], ["10jt", 10000000]];

function kb(rows) { return { reply_markup: { inline_keyboard: rows } }; }
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// --- Preset keterangan (generik: kind "keluar" / "masuk") ---
async function sendCatatPicker(env, chatId, uid, kind) {
  const cfg = await getConfig(env, uid);
  const presets = presetsFor(cfg, kind);
  const rows = chunk(presets.map((p, i) => ({ text: p, callback_data: `pn:${kind}:${i}` })), 3);
  rows.push([
    { text: "✏️ Ketik bebas", callback_data: `free:${kind}` },
    { text: "⚙️ Preset", callback_data: `pmng:${kind}` },
  ]);
  rows.push([BACK_BTN]);
  const head = kind === "masuk"
    ? "🟢 Pemasukan — tap sumber lalu ketik nominalnya."
    : "🔴 Pengeluaran — tap keterangan lalu ketik nominalnya.";
  return sendMessage(env, chatId, head + "\nAtau ✏️ Ketik bebas (nominal + keterangan sekaligus).", kb(rows));
}
async function sendPresetManage(env, chatId, uid, kind) {
  const cfg = await getConfig(env, uid);
  const presets = presetsFor(cfg, kind);
  const rows = chunk(presets.map((p, i) => ({ text: `🗑️ ${p}`, callback_data: `pdel:${kind}:${i}` })), 2);
  rows.unshift([{ text: "➕ Tambah preset", callback_data: `padd:${kind}` }]);
  rows.push([{ text: "↩️ Reset ke default", callback_data: `prst:${kind}` }]);
  rows.push([{ text: kind === "masuk" ? "🔙 Pemasukan" : "🔙 Pengeluaran", callback_data: kind === "masuk" ? "add_masuk" : "add_keluar" }, BACK_BTN]);
  const label = kind === "masuk" ? "pemasukan" : "pengeluaran";
  return sendMessage(env, chatId, `⚙️ Kelola preset ${label}.\nTap 🗑️ untuk hapus, atau tambah baru:`, kb(rows));
}
async function addPreset(env, uid, kind, label) {
  label = (label || "").trim().slice(0, 20);
  if (!label) return;
  const cfg = await getConfig(env, uid);
  const f = presetField(kind);
  const list = presetsFor(cfg, kind).slice();
  if (list.some((x) => x.toLowerCase() === label.toLowerCase())) return;
  list.push(label);
  cfg[f] = list.slice(0, 24);
  await saveConfig(env, uid, cfg);
}
async function removePreset(env, uid, kind, idx) {
  const cfg = await getConfig(env, uid);
  const f = presetField(kind);
  const list = presetsFor(cfg, kind).slice();
  if (idx < 0 || idx >= list.length) return;
  list.splice(idx, 1);
  cfg[f] = list;
  await saveConfig(env, uid, cfg);
}

// Tampilkan pilihan nominal (preset + ketik). `typeMode` = mode saat user pilih "✏️ Ketik".
function sendNominalPicker(env, chatId, title, prefix, presets, typeMode) {
  const rows = chunk(presets.map(([lbl, val]) => ({ text: "Rp" + lbl, callback_data: `${prefix}:${val}` })), 3);
  rows.push([{ text: "✏️ Ketik nominal", callback_data: `typeamt:${typeMode}` }]);
  rows.push([BACK_BTN]);
  return sendMessage(env, chatId, title + "\nPilih cepat atau ketik sendiri:", kb(rows));
}

// Deretan tombol dompet (pakai indeks agar aman untuk callback).
async function sendWalletPicker(env, chatId, uid, title, prefix) {
  const cfg = await getConfig(env, uid);
  const rows = chunk(cfg.wallets.map((w, i) => ({ text: w, callback_data: `${prefix}:${i}` })), 2);
  rows.push([BACK_BTN]);
  return sendMessage(env, chatId, title, kb(rows));
}

// --- Pindah antar dompet ---
async function wPindahFrom(env, chatId, uid) {
  return sendWalletPicker(env, chatId, uid, "🔁 Pindah dana — dari dompet mana?", "pf");
}
async function wPindahTo(env, chatId, uid, fromIdx) {
  const cfg = await getConfig(env, uid);
  const rows = chunk(
    cfg.wallets.map((w, i) => ({ w, i })).filter((x) => x.i !== fromIdx).map((x) => ({ text: x.w, callback_data: `pt:${fromIdx}:${x.i}` })),
    2,
  );
  rows.push([BACK_BTN]);
  return sendMessage(env, chatId, `Dari ${cfg.wallets[fromIdx] || "?"} → ke dompet mana?`, kb(rows));
}
function wPindahNominal(env, chatId, uid, i, j) {
  return sendNominalPicker(env, chatId, "🔁 Pindah berapa?", `pv:${i}:${j}`, CASH_PRESET, `pindahamt:${i}:${j}`);
}
async function execPindah(env, chatId, uid, i, j, amount) {
  const cfg = await getConfig(env, uid);
  const from = cfg.wallets[i], to = cfg.wallets[j];
  if (!from || !to) return sendMessage(env, chatId, "Dompet tak valid, coba lagi dari menu.", BACK_MENU);
  await addEntry(env, uid, { kind: "mutasi", amount, note: `pindah ${from}→${to}`, from, to, ts: Date.now(), src: "tombol" });
  return sendMessage(env, chatId, `✅ ${fmtRp(amount)} — ${from} → ${to}\n(pindah dompet, bukan pengeluaran)`, BACK_MENU);
}

// --- Hutang / Piutang berbasis tombol ---
const DEBT_PRESET = [["20rb", 20000], ["50rb", 50000], ["100rb", 100000], ["200rb", 200000], ["500rb", 500000], ["1jt", 1000000]];

// Nama orang unik dari catatan hutang/piutang, terbaru dulu (maks 8).
function recentParties(list, kind) {
  const seen = new Set();
  const out = [];
  for (const e of list.filter((x) => x.kind === kind && x.party).sort((a, b) => b.ts - a.ts)) {
    const key = e.party.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e.party);
    if (out.length >= 8) break;
  }
  return out;
}
async function wDebtParty(env, chatId, uid, kind) {
  const parties = recentParties(await getEntries(env, uid), kind);
  const rows = chunk(parties.map((p, i) => ({ text: "👤 " + p, callback_data: `dp:${kind}:${i}` })), 2);
  rows.push([{ text: "✍️ Nama baru", callback_data: `dpnew:${kind}` }, { text: "✏️ Ketik lengkap", callback_data: `dpfull:${kind}` }]);
  rows.push([BACK_BTN]);
  const head = kind === "hutang" ? "📕 Hutang — kamu pinjam ke siapa?" : "📗 Piutang — siapa yang pinjam ke kamu?";
  return sendMessage(env, chatId, head, kb(rows));
}
// Nama dipilih. Kalau nominal sudah ada (dari struk) -> langsung simpan.
// Kalau belum -> lanjut pilih nominal.
async function debtPickedParty(env, chatId, uid, kind, party) {
  const d = await getDebtDraft(env, uid);
  if (d && d.amount != null) {
    await clearDebtDraft(env, uid);
    const ts = Date.now();
    const note = d.note || "(tanpa keterangan)";
    await addEntry(env, uid, { kind, amount: d.amount, note, party, status: "belum", ts, src: "foto" });
    const label = kind === "hutang"
      ? `📕 Hutang dicatat: kamu pinjam ${fmtRp(d.amount)} ke ${party}`
      : `📗 Piutang dicatat: ${party} pinjam ${fmtRp(d.amount)} ke kamu`;
    return sendMessage(env, chatId, `${label} (${note})\n🗓️ ${namaHariTanggal(ts)} · ${jamPendek(ts)}`, BACK_MENU);
  }
  return wDebtNominal(env, chatId, uid, kind, party);
}
async function wDebtNominal(env, chatId, uid, kind, party) {
  await setDebtDraft(env, uid, { kind, party });
  return sendNominalPicker(env, chatId, `${kind === "hutang" ? "📕" : "📗"} ${party} — nominal berapa?`, "dv", DEBT_PRESET, "debtamt");
}
async function execDebt(env, chatId, uid, amount) {
  const d = await getDebtDraft(env, uid);
  if (!d) return sendMessage(env, chatId, "Sesi kadaluarsa. Mulai lagi dari menu.", BACK_MENU);
  await clearDebtDraft(env, uid);
  const ts = Date.now();
  await addEntry(env, uid, { kind: d.kind, amount, note: "(tanpa keterangan)", party: d.party, status: "belum", ts, src: "tombol" });
  const label = d.kind === "hutang"
    ? `📕 Hutang dicatat: kamu pinjam ${fmtRp(amount)} ke ${d.party}`
    : `📗 Piutang dicatat: ${d.party} pinjam ${fmtRp(amount)} ke kamu`;
  return sendMessage(env, chatId, `${label}\n🗓️ ${namaHariTanggal(ts)} · ${jamPendek(ts)}`, BACK_MENU);
}
function debtDraftKey(uid) { return `ddraft:${uid}`; }
async function setDebtDraft(env, uid, d) { await env.EXPENSES.put(debtDraftKey(uid), JSON.stringify(d), { expirationTtl: 900 }); }
async function getDebtDraft(env, uid) { const r = await env.EXPENSES.get(debtDraftKey(uid)); return r ? JSON.parse(r) : null; }
async function clearDebtDraft(env, uid) { await env.EXPENSES.delete(debtDraftKey(uid)); }

// --- Set saldo awal ---
async function wSetSaldoWallet(env, chatId, uid) {
  return sendWalletPicker(env, chatId, uid, "💼 Set saldo — dompet mana?", "ssw");
}
function wSetSaldoNominal(env, chatId, uid, i) {
  return sendNominalPicker(env, chatId, "💼 Saldo sekarang berapa?", `ssv:${i}`, BIG_PRESET, `setsaldoamt:${i}`);
}
async function execSetSaldo(env, chatId, uid, i, amount) {
  const cfg = await getConfig(env, uid);
  const w = cfg.wallets[i];
  if (!w) return sendMessage(env, chatId, "Dompet tak valid, coba lagi dari menu.", BACK_MENU);
  return handleDompet(env, chatId, uid, `saldo ${w} ${amount}`);
}

// --- Dompet: menu kelola berbasis tombol ---
async function sendDompetMenu(env, chatId, uid) {
  const cfg = await getConfig(env, uid);
  const bal = walletBalances(await getEntries(env, uid), cfg);
  const lines = ["👛 Dompet:", ""];
  for (const w of cfg.wallets) lines.push(`• ${w}: ${fmtRp(bal[w] || 0)}${w === cfg.defaultWallet ? " ⭐" : ""}`);
  const rows = [
    [{ text: "➕ Tambah", callback_data: "dw_add" }, { text: "🗑️ Hapus", callback_data: "dw_delp" }],
    [{ text: "⭐ Set utama", callback_data: "dw_mainp" }, { text: "💼 Set saldo", callback_data: "add_setsaldo" }],
    [BACK_BTN],
  ];
  return sendMessage(env, chatId, lines.join("\n"), kb(rows));
}
async function dompetByIndex(env, chatId, uid, action, i) {
  const cfg = await getConfig(env, uid);
  const w = cfg.wallets[i];
  if (!w) return sendMessage(env, chatId, "Dompet tak valid.", BACK_MENU);
  return handleDompet(env, chatId, uid, `${action} ${w}`);
}

// --- Laporan: pilih bulan (6 bulan terakhir) ---
function sendMonthPicker(env, chatId, uid) {
  const now = wibParts(Date.now());
  const btns = [];
  for (let k = 0; k < 6; k++) {
    let m = now.m - k, y = now.y;
    while (m <= 0) { m += 12; y -= 1; }
    btns.push({ text: `${NAMA_BULAN[m - 1]} ${y}`, callback_data: `lap:${y}-${String(m).padStart(2, "0")}` });
  }
  const rows = chunk(btns, 2);
  rows.push([BACK_BTN]);
  return sendMessage(env, chatId, "📅 Laporan bulan mana?", kb(rows));
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
  let move = "";
  let t = text;
  if (/^(tarik\s*tunai|tarik|tunai)\b/i.test(t)) {
    kind = "mutasi"; // tarik tunai: pindah bank->cash, bukan pengeluaran
    move = "tarik";
    t = t.replace(/^(tarik\s*tunai|tarik|tunai)\s*/i, "");
  } else if (/^(pindah|transfer)\b/i.test(t)) {
    kind = "mutasi"; // pindah antar dompet
    move = "pindah";
    t = t.replace(/^(pindah|transfer)\s*/i, "");
  } else if (t.startsWith("+")) {
    kind = "masuk";
    t = t.slice(1).trim();
  } else if (t.startsWith("-")) {
    kind = "keluar";
    t = t.slice(1).trim();
  }
  const p = parseAmountToken(t);
  if (!p) return null;
  return { kind, move, amount: p.amount, note: p.rest || "(tanpa keterangan)" };
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
// fetch dengan batas waktu (Workers tak punya opsi timeout bawaan).
async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...(opts || {}), signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
function fmtRp(n) {
  if (n == null || !isFinite(n)) return "Rp?";
  const neg = n < 0;
  // Grup ribuan pakai titik secara manual (tidak bergantung locale runtime).
  const s = String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (neg ? "-" : "") + "Rp" + s;
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

async function sendDocument(env, chatId, content, filename, caption, contentType) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN belum diset");
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([content], { type: contentType || "text/csv" }), filename);
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });
}
