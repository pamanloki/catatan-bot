# CLAUDE.md

Panduan singkat untuk mengembangkan repo ini.

## Apa ini

Bot Telegram **catatan keuangan pribadi** yang berjalan sebagai **Cloudflare Worker**.
Seluruh logika ada di satu file: **`worker.js`** (tanpa framework, tanpa dependency).

Fitur: catat pengeluaran/pemasukan (teks & foto struk/transfer via AI), tarik tunai &
transfer antar **dompet** (saldo per dompet + set saldo awal), hutang/piutang +
pelunasan + backdate tanggal, kategori otomatis, budget + peringatan, laporan
harian/bulanan/bulan-tertentu, grafik pai, cari, edit/hapus per catatan, export CSV,
menu tombol (inline keyboard) dengan "mode" input, dan rekap bulanan otomatis (Cron).

## Deploy

Deploy lewat **dashboard Cloudflare** (bukan Wrangler): buka Worker → **Edit code** →
tempel isi `worker.js` → **Deploy**. Lihat `README.md` untuk langkah lengkap.

Tidak ada build step, test suite, atau linter. Validasi cepat sebelum commit:

```bash
node --check worker.js
```

## Konfigurasi runtime (di dashboard Worker)

Secrets (Settings → Variables and Secrets, tipe Secret):
- `BOT_TOKEN` — token @BotFather (wajib)
- `TELEGRAM_SECRET` — dicek terhadap header `x-telegram-bot-api-secret-token`
- `ALLOWED_IDS` — daftar id Telegram (koma) untuk mode privat; kosong = terbuka
- `GEMINI_API_KEY` — opsional; kalau ada, foto struk dibaca Gemini (lebih akurat)
- `GEMINI_MODEL` — opsional; default `gemini-3.6-flash`

Bindings (Settings → Bindings):
- KV Namespace → variable **`EXPENSES`** (penyimpanan)
- Workers AI → variable **`AI`** (cadangan pembaca struk bila tanpa Gemini)

`GEMINI_API_KEY` (opsional) → foto struk dibaca Gemini (`GEMINI_MODEL`, default
`gemini-3.6-flash`) dengan `responseSchema` JSON; Workers AI jadi cadangan.

Cron Trigger `0 0 1 * *` → memicu `scheduled` untuk rekap bulanan.

## Arsitektur `worker.js`

`export default` punya dua entry point:
- `fetch(request, env)` — webhook Telegram (POST) & halaman status (GET)
- `scheduled(event, env, ctx)` — dijalankan Cron → `runScheduled()`

Alur pesan: `handleTelegram` → `routeMessage` (perintah teks / foto) atau
`handleCallback` (tombol inline keyboard). Balasan lewat `sendMessage` /
`sendPhoto` / `sendDocument` (Telegram Bot API langsung via `fetch`).

Bagian file (dipisah komentar `// ---`): Telegram core, Foto struk (AI),
Hutang/Piutang, Penyimpanan KV, Laporan & export, Util (parsing, format, menu).

## Model data (KV)

- `exp:<uid>` → array entri:
  `{ ts, kind, amount, note, category, party, status, wallet, from, to, src }`
  - `kind`: `keluar` | `masuk` | `hutang` | `piutang` | `mutasi`
  - `amount`: rupiah (integer)
  - `status`: hanya hutang/piutang → `belum` | `lunas`
  - `party`: nama (hutang/piutang); `ts` bisa di-backdate lewat `tgl 15-3-2025`
  - `wallet`: dompet untuk masuk/keluar; `from`/`to`: dompet untuk `mutasi`
  - `mutasi` = tarik tunai / transfer / set-saldo-awal → **tidak** dihitung
    sebagai pemasukan/pengeluaran; hanya memengaruhi saldo dompet
- `cfg:<uid>` → `{ budget, wallets[], defaultWallet }`
- `mode:<uid>` → string sementara (TTL 15 mnt): input teks berikutnya diproses
  sesuai tombol yang ditekan (`keluar`/`masuk`/`mutasi`/`pindah`/`setsaldo`/
  `hutang`/`piutang`/`edit_amount:<ts>`/`edit_note:<ts>`)

`uid` = id user Telegram = chat_id (private chat), dipakai langsung untuk kirim
pesan terjadwal.

Saldo dompet dihitung on-the-fly oleh `walletBalances(list, cfg)` — tidak disimpan.

## Konvensi

- Zona waktu **WIB (UTC+7)** — pakai `wibParts(ts)`, jangan `getHours()` lokal.
- Uang diformat `fmtRp()`; parsing input `parseAmountToken()` (dukung rb/ribu/k, jt/juta,
  pemisah ribuan).
- Perintah baru: tambah cabang di `routeMessage`; kalau perlu tombol, tambah ke
  keyboard menu + `handleCallback`.
- Fungsi hasil (laporan dll) menerima argumen `markup` opsional untuk menempel
  tombol "🔙 Menu" saat dipanggil dari callback.
- Komentar & teks bot dalam Bahasa Indonesia.
- Semua I/O dibungkus timeout/try-catch bila menyentuh jaringan.

## Menambah fitur (contoh)

1. Perintah teks → tambah `if (lower.startsWith("/xxx")) return handleXxx(...)`
   di `routeMessage`.
2. Tombol → tambah entri di keyboard (`MENU_*`) dan `case` di `handleCallback`.
3. Input multi-langkah tanpa mengetik perintah → `setMode()` di callback tombol,
   lalu tangani di `handleModeInput` (dibaca di `routeMessage` sebelum `recordFlow`).
4. Butuh data baru per entri → tambah field di `addEntry` (beri default agar entri
   lama tetap valid). Jenis yang tak boleh masuk hitungan arus kas → pakai `kind`
   selain `masuk`/`keluar` (laporan hanya menjumlah kedua itu).
