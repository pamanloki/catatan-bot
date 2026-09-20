# catatan-bot

Bot Telegram untuk mencatat pengeluaran, jalan di **Cloudflare Worker**.

- 📝 Catat manual: kirim `50rb makan siang`, `12000 parkir`, `1,5jt sewa`
- 📸 Foto struk: kirim foto → total & toko dibaca **Workers AI** otomatis
- 📊 `/laporan` rekap hari ini + bulan ini
- 💰 `/total` total sepanjang waktu
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
- Foto struk memakai **Workers AI** (ada jatah gratis harian). Akurasi tergantung kejelasan foto; kalau meleset, catat manual saja.
- Waktu memakai zona **WIB (UTC+7)**.
