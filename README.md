# catatan-bot

Bot Telegram untuk mencatat keuangan pribadi, berjalan di **Cloudflare Worker**.
Seluruh logika ada di satu file: `worker.js` (tanpa framework/dependency).

## Fitur

**Mencatat**
- 🔴 Pengeluaran: `50rb makan siang` (atau `-50rb makan`)
- 🟢 Pemasukan: `+5jt gaji` (awali `+`)
- 💵 Tarik tunai: `tarik 500rb` (Bank→Cash, **bukan** pengeluaran)
- 🧾 Foto struk / transfer / e-wallet: kirim fotonya, nominal dibaca AI
- Opsi saat mencatat: dompet `@gopay`, tanggal `tgl 15-3-2025`, kategori `#tag`

**Hutang / Piutang**
- 📕 `/hutang 100rb budi bensin` · 📗 `/piutang 50rb ani` (bisa `+ tgl`)
- 📋 `/utang` rekap · ✅ `/lunas` lihat & lunasi (tap tombol)

**Dompet** 👛
- Lacak saldo per tempat uang (Cash, Bank, GoPay, …)
- `/saldo` · `/dompet` (tambah/hapus/utama/**saldo awal**) · `pindah 200rb bank gopay`

**Budget** 🎯
- `/budget 3jt` set batas bulanan; peringatan otomatis saat mendekati/lewat

**Laporan & data**
- 📊 `/laporan` (hari & bulan ini, per kategori) · `/laporan agustus` (bulan tertentu)
- 📈 `/grafik` pai per kategori · 🔍 `/cari grab` · 💰 `/total`
- 📊 `/excel` — file **.xlsx**: 1 sheet per bulan, format Rupiah otomatis, saldo berjalan (seperti rekening koran)
- 📄 `/export` — CSV (data mentah: kolom Bulan, Masuk/Keluar, Saldo berjalan; angka polos aman di semua locale)
- 🗓️ Rekap bulan lalu dikirim **otomatis** tiap awal bulan (Cron)

**Kelola & lainnya**
- ✏️ `/edit` ubah/hapus catatan · `/hapus` · `/hapusall`
- 📱 `/menu` tombol cepat · `/setup` daftarkan menu perintah Telegram
- 🔒 Privat lewat `ALLOWED_IDS`

## Setup (via dashboard Cloudflare, tanpa Wrangler)

1. **Buat Worker** → **Edit code** → tempel isi `worker.js` → **Deploy**.

2. **Secrets** (Settings → Variables and Secrets, tipe **Secret**):

   | Name | Value |
   |------|-------|
   | `BOT_TOKEN` | token dari @BotFather (wajib) |
   | `TELEGRAM_SECRET` | string acak bebas (disarankan) |
   | `ALLOWED_IDS` | ID Telegram-mu, dipisah koma (untuk privat) |
   | `GEMINI_API_KEY` | opsional — baca struk **jauh lebih akurat** (lihat bawah) |
   | `GEMINI_MODEL` | opsional — default `gemini-3.6-flash` |
   | `OPENROUTER_API_KEY` | opsional — pakai **Qwen-VL** (dsb) via OpenRouter (lihat bawah) |
   | `OPENROUTER_MODEL` | opsional — default `qwen/qwen-2.5-vl-72b-instruct` (**harus model vision/VL**) |

3. **Bindings** (Settings → Bindings):
   - **KV Namespace** → buat namespace → bind ke variable **`EXPENSES`**
   - **Workers AI** → bind ke variable **`AI`** (cadangan pembaca struk)

4. **Deploy** ulang setiap kali menambah secret/binding.

5. **Daftarkan webhook** (buka di browser, ganti `<...>`):
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<TELEGRAM_SECRET>
   ```

6. Kirim `/start` ke bot, lalu `/setup` sekali agar tombol menu Telegram aktif.

### Baca struk lebih akurat (Gemini, gratis)

Model vision gratis Cloudflare kurang jago baca angka struk. Untuk hasil jauh lebih baik:
1. Buat API key gratis di **Google AI Studio** — https://aistudio.google.com/apikey
2. Tambahkan sebagai Secret `GEMINI_API_KEY`, lalu Deploy.
3. Bot otomatis pakai Gemini untuk baca struk; Workers AI jadi cadangan.

### Alternatif: Qwen-VL via OpenRouter

Mau coba model lain (Qwen-VL, dll) tanpa ganti kode:
1. Buat API key di **OpenRouter** — https://openrouter.ai/keys
2. Tambahkan Secret `OPENROUTER_API_KEY` (dan opsional `OPENROUTER_MODEL`, **harus model vision/VL**
   mis. `qwen/qwen-2.5-vl-72b-instruct`), lalu Deploy.
3. Di bot ketik `/ai qwen` (atau tombol **🐉 Qwen-VL** di menu `/ai`) untuk menjadikannya mesin utama.
   Kalau mesin utama gagal, bot otomatis coba mesin lain yang tersedia.
4. **Pilih model** lewat `/model` (atau tombol **🎛️ Pilih model** di menu `/ai`): ada daftar model
   vision siap pakai + opsi **ketik slug sendiri**. Pilihan model disimpan per user.

> **Penting:** model teks biasa (mis. `qwen-flash`/`qwen-turbo`) **tidak bisa** baca gambar.
> Harus model **vision/VL**.

### Rekap bulanan otomatis (Cron)

1. Worker → **Settings → Triggers → Cron Triggers → Add Cron Trigger**.
2. Jadwal: `0 0 1 * *` (tanggal 1 tiap bulan, 00:00 UTC = 07:00 WIB) → **Deploy**.

Handler `scheduled` mengirim rekap bulan lalu ke tiap pengguna yang punya transaksi.
(Aman juga kalau diisi harian `0 0 * * *` — bot hanya mengirim saat tanggal 1.)

## Catatan

- Data & pengaturan disimpan di **Cloudflare KV** (gratis di tier dasar), per user Telegram.
- Foto struk memakai **Gemini** (jika ada key) atau **Workers AI**; akurasi tergantung kejelasan foto.
- Export memakai **CSV** (bukan PDF): PDF di Worker butuh library berat, CSV ringan & langsung rapi di Excel/Google Sheets.
- Saldo dompet dihitung dari transaksi (masuk/keluar/transfer); set titik awal dengan `/dompet saldo <nama> <jumlah>`.
- Zona waktu **WIB (UTC+7)**.
