# ercü-bot

Memeler, mini oyunlar/ekonomi, YouTube'dan müzik ve moderasyon araçlarıyla dolu, Türkçe ve esnaf/argo esprili bir Discord botu. discord.js v14 ve SQLite ile yazıldı. Komutlar Discord'un slash-komut arayüzü yerine metin öneki (varsayılan `!`) ile çalışır.

## Özellikler

- **Meme:** `!meme`, `!caption`
- **Eğlence:** `!sallama`, `!sok`, `!capsle`, `!eksi`
- **Müzik:** `!play`, `!skip`, `!stop`, `!pause`, `!resume`, `!queue`, `!np`
- **Moderasyon/Yardımcı:** `!warn`, `!warnings`, `!poll`, `!remind`, `!ping`, `!userinfo`, `!serverinfo`, `!help`
- **Oyunlar/Ekonomi:** `!balance`, `!daily`, `!work`, `!slots`, `!blackjack`, `!trivia`, `!cs2`, `!lineup`, `!oyun`, `!leaderboard`
- Bir üye katıldığında karşılama mesajı (`WELCOME_CHANNEL_ID` ayarlıysa)

Sunucunda tüm komutları ve kullanım şeklini görmek için `!help` yaz. Argümanlar konuma göre sıralanır: kullanıcıları `@` ile etiketle, çok kelimeli metinleri son argüman değilse `"tırnak içine"` al (örn. `!warn @kullanici "kurallara uymuyor"`); son metin argümanı (örn. `!poll` seçeneği veya `!remind` mesajı) tırnak gerektirmeden mesajın geri kalanı olarak alınır.

## 1. Discord uygulamasını oluştur

1. [Discord Developer Portal](https://discord.com/developers/applications)'a git ve yeni bir uygulama oluştur.
2. **Bot** sekmesinde bir bot kullanıcısı oluştur, **token**'ı kopyala (bu `DISCORD_TOKEN`).
3. **Bot → Privileged Gateway Intents** altında **Server Members Intent** (karşılama mesajları, üye aramaları) ve **Message Content Intent**'i (önekli komutları okumak için zorunlu, örn. `!meme`) etkinleştir.
4. **OAuth2 → General** altında **Application ID**'yi kopyala (bu `CLIENT_ID`, referans/ileride kullanım için tutulur).
5. **OAuth2 → URL Generator** altında `bot` scope'unu seç (slash komut olmadığı için `applications.commands` gerekmez), izinler: Moderate Members, Manage Messages, Send Messages, Embed Links, Attach Files, Add Reactions, Read Message History, Connect, Speak (son ikisi `!play` müzik komutu için sesli kanala bağlanabilmek adına gerekli). Oluşan URL ile botu sunucuna davet et.
6. Sunucunun ID'sini kopyala (Discord'da Geliştirici Modunu aç, sunucu ikonuna sağ tıkla → Sunucu ID'sini Kopyala) — bu `GUILD_ID`.

## 2. Ortam değişkenlerini ayarla

`.env.example` dosyasını `.env` olarak kopyala ve değerleri doldur:

```
DISCORD_TOKEN=your-bot-token
CLIENT_ID=your-application-id
GUILD_ID=your-server-id
WELCOME_CHANNEL_ID=          # opsiyonel, karşılama mesajları için kanal ID'si
MOD_ROLE_ID=                 # opsiyonel, moderatör sayılacak ek rol ID'si
PREFIX=!                     # komut öneki
```

## 3. Yerelde çalıştır (deploy etmeden önce)

`better-sqlite3` ve `canvas` native modüllerdir — Node sürümünle eşleşen hazır bir binary yoksa kaynaktan derlenmek için Python + bir C++ toolchain isterler. Windows'ta en kolay yol, host üzerinde çıplak `node` çalıştırmak yerine doğrudan Docker ile test etmektir (ihtiyacı olan her şey zaten kurulu, bkz. adım 4):

```bash
docker compose build
docker compose up
```

Doğrudan Node ile çalıştırmayı tercih ediyorsan (Linux/macOS, ya da Python 3 + Visual Studio Build Tools kurulu Windows):

```bash
npm install
npm start   # ya da: node src/index.js
```

Konsolda "Logged in as ..." çıktığını ve botun sunucunda Çevrimiçi göründüğünü doğrula. Her komut kategorisini Discord'da canlı test et: `!ping`, `!meme`, `!daily`, `!slots 50`, `!blackjack 50`, `!trivia`, `!cs2`, `!lineup ancient smoke ct`, `!oyun indirimde`, `!sallama <soru>`, `!sok @kullanici`, `!capsle <resim_url>`, `!eksi <baslik>`, `!warn @kullanici sebep`, `!poll "soru" "a" "b"`, `!remind 10m mesaj`, `!help`. Müzik komutlarını test etmek için önce bir sesli kanala gir, sonra `!play <şarkı adı ya da YouTube linki>`, `!queue`, `!skip`, `!pause`, `!resume`, `!np`, `!stop` sırasıyla dene.

## 4. VPS'ine Docker ile deploy et

VPS'te zaten Docker, docker-compose ve nginx kurulu — bu bot nginx ya da dışa açık bir port istemiyor, sadece Discord'un gateway'ine giden bağlantılar kuruyor.

```bash
# VPS'te, proje dizini içinde (repoyu + gerçek .env dosyanı oraya kopyaladıktan sonra)
docker-compose up -d --build
docker-compose logs -f bot        # temiz başladığını doğrula
```

SQLite veritabanı (`/app/data/bot.sqlite`) `bot-data` adlı Docker volume'unda tutulur, bu yüzden bakiyeler/uyarılar/hatırlatıcılar container yeniden derlense (`docker-compose up --build`) ya da VPS yeniden başlasa da kalıcı olur. `restart: always` çökmelerde ve yeniden başlatmalarda botu ayakta tutar.

Kod değişikliğinden sonra botu güncellemek için:

```bash
git pull   # ya da dosyaları yeniden yükle
docker-compose up -d --build
```

### YouTube "Sign in to confirm you're not a bot" hatası

VPS'in IP'si bir veri merkezine ait olduğu için YouTube bazı istekleri bot doğrulamasına sokuyor ve şarkı çekilemiyor
("... çekilemedi: YouTube bot doğrulaması istedi"). Çözüm, oturum açmış bir tarayıcıdan dışa aktarılan çerez dosyası:

1. Ana hesabın değil, **ayrı (yan) bir Google hesabının** oturumunu aç: çerezle yapılan yoğun istek hesabı işaretleyebilir.
2. Gizli pencerede o hesapla youtube.com'a gir, yt-dlp'nin önerdiği yolla çerezleri Netscape biçiminde dışa aktar
   (https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies), pencereyi kapat (çerezler dönmesin).
3. Dosyayı VPS'te `secrets/youtube-cookies.txt` olarak bırak (proje dizininde; `secrets/` gitignore ve dockerignore'da):
   `scp youtube-cookies.txt markahost:/home/furkan/ercu-bot/secrets/`
4. `docker compose up -d` (yeniden derleme gerekmez; compose `./secrets`'i salt okunur bağlar). Bot dosyayı kendisi bulur;
   yenisi bırakılınca bir sonraki şarkıda onu kullanır. Başka yerde duruyorsa `.env`'e `YTDLP_COOKIES=/yol` yazılır.

yt-dlp her build'de son sürüme güncellenir (Dockerfile, sürümün sağlama dosyasına bağlı katman); hata çerezle de sürerse
yeni bir yt-dlp sürümü çıkmış olabilir: `docker compose build && docker compose up -d`.

## Notlar

- `.env` dosyasını asla commit'leme — zaten gitignore'da. Çerez dosyası (`secrets/`) da öyle.
- `canvas` (`!caption`, `!capsle` tarafından kullanılıyor) için Alpine tabanlı Docker build'i VPS'inde yavaş çalışıyor ya da başarısız oluyorsa, Dockerfile'ın base image'ını `node:20-bookworm-slim` yap ve `apk add` satırını `apt-get install -y python3 make g++ libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev` ile değiştir.
- Müzikte çalan şarkının Opus paketleri bellekte tutulur (varsayılan en fazla 20 MB; `.env`: `SARMA_ONBELLEK_MB`). İleri/geri sarma ve şarkı tekrarı YouTube'a yeni istek atmadan bu bellekten yapılır; sınırı aşan uzun içerikler (yaklaşık 17 dk üstü) eskisi gibi akıştan çalınır, sarma yt-dlp/ffmpeg ile yapılır. Diğer isteğe bağlı ayarlar `.env.example` içinde.
- `!play` müzik komutu ses dönüştürme için `ffmpeg-static` paketinin indirdiği ffmpeg'i kullanır — ayrıca sistemde ffmpeg kurulu olmasına gerek yok.
- Önekli komutlarda ephemeral (özel/gizli) yanıt diye bir şey yok — her yanıt normal, herkese görünen bir kanal mesajıdır.
