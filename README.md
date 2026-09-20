# catatan-bot

Bot Telegram untuk mencatat keuangan pribadi, jalan di **Cloudflare Worker**.

- 🔴 **Pengeluaran**: `50rb makan siang`, `12000 parkir`
- 🟢 **Pemasukan**: `+5jt gaji` (awali dengan tanda `+`)
- 📸 **Foto struk**: kirim foto → total & toko dibaca **Workers AI** (jadi pengeluaran)
- 📕 **Hutang** (kamu pinjam): `/hutang 100rb budi beli bensin` — bisa set tanggal: `... tgl 15-3-2025`
- 📗 **Piutang** (orang pinjam ke kamu): `/piutang 50rb ani`
- 📈 **Grafik** pai per kategori: `/grafik`
- 📅 **Laporan bulan tertentu**: `/laporan agustus` atau `/laporan 2026-08`
- 🔍 **Cari** transaksi: `/cari grab`
- ✅ **Lunasi**: `/lunas` (lihat daftar), `/lunas 2` (lunasi nomor 2)
- 🎯 **Budget bulanan**: `/budget 3jt` set batas, peringatan otomatis saat mendekati/lewat; tiap catat pengeluaran langsung tampil sisa budget
- 🏷️ **Kategori otomatis** dari kata kunci (atau paksa dengan `#tag`), lengkap dengan rekap per kategori di laporan
- 📊 `/laporan` rekap hari & bulan ini (masuk, keluar, saldo, per kategori, hutang/piutang)
- 💰 `/total` total sepanjang waktu
- 📄 `/export` unduh **CSV** (buka rapi di Excel / Google Sheets)
- 🗑️ `/hapus` hapus catatan terakhir
- 🔒 Bisa dikunci privat lewat `ALLOWED_IDS`

## Setup (via dashboard Cloudflare, tanpa Wrangler)

1. **Buat Worker** baru → **Edit code** → tempel isi `worker.js` → **Deploy**.

2. **Secrets** (Settings → Variables and Secrets, tipe **Secret**):
   | Name | Value |
   |------|-------|
   | `BOT_TOKEN` | token dari @BotFather (wajib) |
   | `TELEGRAM_SECRET` | string acak bebas (disarankan) |
   | `ALLOWED_IDS` | ID Telegram-mu, dipisah koma (untuk privat) |

   | `GEMINI_API_KEY` | (opsional) API key Google Gemini — baca struk **jauh lebih akurat** daripada Workers AI |

3. **Bindings** (Settings → Bindings):
   - **KV Namespace** → buat namespace baru → bind ke variable name **`EXPENSES`**
   - **Workers AI** → bind ke variable name **`AI`** (dipakai untuk struk kalau tidak ada `GEMINI_API_KEY`)

### Baca struk lebih akurat (Gemini, gratis)

Model vision gratis Cloudflare kurang jago baca angka di struk. Untuk hasil jauh lebih baik:
1. Buat API key gratis di **Google AI Studio** (https://aistudio.google.com/apikey).
2. Tambah sebagai **Secret** `GEMINI_API_KEY` di Worker.
3. Bot otomatis pakai Gemini untuk baca struk; Workers AI jadi cadangan.

4. **Deploy** ulang setelah menambah secret/binding.

5. **Daftarkan webhook** (buka di browser, ganti `<...>`):
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<TELEGRAM_SECRET>
   ```

## Catatan

- Data disimpan di **Cloudflare KV** (gratis di tier dasar), per user Telegram.
- Foto struk memakai **Workers AI** (jatah gratis harian); akurasi tergantung kejelasan foto.
- Export memakai **CSV**, bukan PDF: membuat PDF di dalam Worker butuh library berat, sedangkan CSV ringan & langsung rapi saat dibuka di Excel/Google Sheets.
- Zona waktu **WIB (UTC+7)**.
