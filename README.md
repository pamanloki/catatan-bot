# catatan-bot

Bot Telegram untuk mencatat keuangan pribadi, jalan di **Cloudflare Worker**.

- 🔴 **Pengeluaran**: `50rb makan siang`, `12000 parkir`
- 🟢 **Pemasukan**: `+5jt gaji` (awali dengan tanda `+`)
- 📸 **Foto struk**: kirim foto → total & toko dibaca **Workers AI** (jadi pengeluaran)
- 📕 **Hutang** (kamu pinjam): `/hutang 100rb budi beli bensin`
- 📗 **Piutang** (orang pinjam ke kamu): `/piutang 50rb ani`
- ✅ **Lunasi**: `/lunas` (lihat daftar), `/lunas 2` (lunasi nomor 2)
- 📊 `/laporan` rekap hari & bulan ini (masuk, keluar, saldo, hutang/piutang)
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

3. **Bindings** (Settings → Bindings):
   - **KV Namespace** → buat namespace baru → bind ke variable name **`EXPENSES`**
   - **Workers AI** → bind ke variable name **`AI`**

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
