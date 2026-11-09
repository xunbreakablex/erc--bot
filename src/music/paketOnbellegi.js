// Çalan şarkının Opus paketlerini bellekte tutar; çalma ve sarma bu paket dizisinden yapılır.
//
// Neden: sarma için yeni bir ses akışı açmak her seferinde YouTube'a yeni istek atmak (yt-dlp/ffmpeg) demekti ve
// sunucuda YouTube bu isteği reddedince sarma düşüyordu. Şarkı zaten çalmak için bir kez iniyor; indirilen
// paketleri saklarsak sarma, dizide konum değiştirmekten ibaret olur: ağ yok, ffmpeg yok, anında ve kare kare doğru.
//
// Opus paketleri 20 ms'dir (saniyede 50 paket). Boyut: ~1 MB/dk (ölçülen: 213 sn'lik şarkı 3,4 MB). Bellek sınırı
// için yalnızca süresi bilinen ve sınıra sığan şarkılar tutulur; uzun içerikler (podcast, saatlik videolar)
// bugünkü gibi akıştan çalınır ve sarmada yedek yol kullanılır.
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const logger = require('../utils/logger');

// prism-media, @discordjs/voice'un bağımlılığı. Doğrudan bulunamazsa voice'un yanından aranır; hiç yüklenemezse
// önbellek kapalı kalır ve bot eskisi gibi çalışır.
function prismYukle() {
  try {
    return require('prism-media');
  } catch {
    // aşağıda voice'un yanından denenecek
  }
  try {
    return require(require.resolve('prism-media', { paths: [require.resolve('@discordjs/voice')] }));
  } catch {
    return null;
  }
}
const prism = prismYukle();

const MB = 1024 * 1024;
const SINIR_BAYT = (Number(process.env.SARMA_ONBELLEK_MB) || 20) * MB;
// YouTube Opus'u ~130 kbps (~16 KB/sn); değişken bit hızına karşı payla 20 KB/sn varsayılıyor.
const TAHMINI_BAYT_SN = 20_000;
// Süre bilgisi yanlış çıkarsa bellek sonsuza kadar büyümesin: beklenen sınırın iki katında indirme kesilir.
const KESME_BAYT = SINIR_BAYT * 2;
const PAKET_MS = 20;

// Şarkı süresine göre bellekte tutulup tutulmayacağına karar verir (süresi bilinmeyen/canlı yayınlar tutulmaz).
function onbellegeUygunMu(sureSn) {
  return Boolean(prism) && Number.isFinite(sureSn) && sureSn > 0 && sureSn * TAHMINI_BAYT_SN <= SINIR_BAYT;
}

class PaketOnbellegi extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.paketler = [];
    this.bayt = 0;
    this.tamamlandi = false;
    this.eksik = false; // akış tam bitmeden koptuysa ya da kesildiyse true: tekrar çalmada kullanılmaz
    this.temizlendi = false;
    this.kaynak = null;
    this.sonOkuyucu = null;
    this.kill = () => {};
    this.setMaxListeners(20);
  }

  ekle(paket) {
    if (this.temizlendi || this.tamamlandi) return;
    this.paketler.push(paket);
    this.bayt += paket.length;
    if (this.bayt > KESME_BAYT) {
      logger.error(`Paket önbelleği sınırı aşıldı (${Math.round(this.bayt / MB)} MB), indirme kesiliyor: ${this.url}`);
      this.eksik = true;
      this.kill();
      this.bitir();
      return;
    }
    this.emit('degisim');
  }

  bitir() {
    if (this.tamamlandi) return;
    this.tamamlandi = true;
    this.emit('degisim');
  }

  // Şarkı bitince ya da değişince bellek bırakılır; indirme sürüyorsa durdurulur.
  temizle() {
    if (this.temizlendi) return;
    this.temizlendi = true;
    this.eksik = true;
    this.kill();
    this.tamamlandi = true;
    this.emit('degisim'); // bekleyen okuyucular bitişi görsün
    this.paketler = [];
    this.bayt = 0;
    this.sonOkuyucu = null;
    this.removeAllListeners();
  }

  get sureSn() {
    return (this.paketler.length * PAKET_MS) / 1000;
  }

  // `index`'inci paketten başlayarak çalan bir akış verir (sarma = yeni okuyucu). Her okuyucu kendi konumunu tutar.
  // Aynı anda tek okuyucu çalar: sarmada yenisi gelince eskisi kapatılır. Aksi halde inmemiş bölüme art arda
  // sarılınca terk edilen okuyucular paket beklemeye devam edip dinleyici biriktirirdi.
  okuyucu(index = 0) {
    this.sonOkuyucu?.destroy();
    this.sonOkuyucu = new PaketOkuyucu(this, Math.max(0, Math.floor(index)));
    return this.sonOkuyucu;
  }
}

// Nesne kipinde Opus paketi akışı: AudioResource'a StreamType.Opus olarak verilir.
// highWaterMark 1: okuyucu ileriye fazla paket tüketmez (sarma yeni okuyucuyla yapılır, eski okuyucu atılır).
class PaketOkuyucu extends Readable {
  constructor(onbellek, index) {
    super({ objectMode: true, highWaterMark: 1 });
    this.onbellek = onbellek;
    this.index = index;
    this.bekliyor = false;
    this.uyandir = () => {
      this.bekliyor = false;
      this._read();
    };
  }

  _read() {
    const onb = this.onbellek;
    if (this.index < onb.paketler.length) {
      this.bekliyor = false;
      this.push(onb.paketler[this.index++]);
      return;
    }
    if (onb.tamamlandi) {
      this.push(null);
      return;
    }
    // Henüz inmemiş bölüme gelindi (örneğin indirilenin ilerisine sarıldı): yeni paket gelince devam edilir.
    if (!this.bekliyor) {
      this.bekliyor = true;
      onb.once('degisim', this.uyandir);
    }
  }

  _destroy(hata, bitti) {
    this.onbellek.off('degisim', this.uyandir);
    bitti(hata);
  }
}

// yt-dlp akışını (WebM/Opus) paketlere ayırıp önbelleğe doldurur. İndirme çalma hızına bağlı değildir: paketler
// gerçek zamandan hızlı birikir, bu yüzden sarma çoğunlukla zaten inmiş bölüme yapılır.
function onbellekKur(url, kaynak, kill) {
  const onb = new PaketOnbellegi(url);
  onb.kaynak = kaynak;
  onb.kill = kill;

  const demuxer = new prism.opus.WebmDemuxer();
  demuxer.on('data', (paket) => onb.ekle(Buffer.from(paket))); // kopya: demuxer'ın iç tamponuna bağlı kalınmasın
  demuxer.on('end', () => onb.bitir());
  demuxer.on('error', (hata) => {
    logger.error(`Paket önbelleği WebM ayrıştırma hatası: ${url}`, hata);
    onb.eksik = true;
    onb.bitir();
  });
  kaynak.on('error', () => {});
  kaynak.pipe(demuxer);
  return onb;
}

module.exports = { onbellegeUygunMu, onbellekKur, PaketOnbellegi, PAKET_MS, SINIR_BAYT };
