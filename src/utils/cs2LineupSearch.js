const { ara } = require('../music/arama');
const { HARITALAR, TIPLER, KANALLAR, sorgular } = require('../content/cs2Lineups');
const logger = require('./logger');

const ONBELLEK_TTL_MS = 6 * 60 * 60 * 1000;
const EN_KISA_SN = 5;
const EN_UZUN_SN = 90;
const EN_FAZLA_SONUC = 20;

const onbellek = new Map();

function kanalPuani(kanalAdi) {
  const index = KANALLAR.findIndex((k) => k.toLocaleLowerCase('en') === String(kanalAdi || '').toLocaleLowerCase('en'));
  return index === -1 ? KANALLAR.length : index;
}

function uygunMu(video, harita, tip) {
  const saniye = video?.duration?.seconds;
  if (!saniye || saniye < EN_KISA_SN || saniye > EN_UZUN_SN) return false;

  const baslik = String(video.title || '').toLowerCase();
  if (!harita.desen.test(baslik)) return false;
  return tip.kelimeler.some((kelime) => baslik.includes(kelime));
}

/**
 * Bir harita/utility tipi için 90 saniyeden kısa lineup kliplerini arar. Taraf/mevki
 * filtresi verilirse terim sorgulara da giriyor, dönen kliplerde ise başlığı filtreye
 * uyanlar `eslesti: true` ile işaretlenip başa alınıyor — süzmeyi çağıran yapıyor ki
 * hiç eşleşme çıkmadığında elde yine de klip kalsın.
 * Sonuçlar 6 saat bellekte tutulur, aynı kombinasyon tekrar aranmaz.
 */
async function lineupAra(haritaKey, tipKey, filtre = null) {
  const anahtar = `${haritaKey}:${tipKey}:${filtre ? filtre.anahtar : '-'}`;
  const kayit = onbellek.get(anahtar);
  if (kayit && Date.now() - kayit.zaman < ONBELLEK_TTL_MS) return kayit.sonuc;

  const harita = HARITALAR[haritaKey];
  const tip = TIPLER[tipKey];
  const bulunanlar = new Map();

  for (const sorgu of sorgular(haritaKey, tipKey, filtre)) {
    // Tek bir sorgu patlarsa diğerleri devam etsin.
    const sonuc = await ara(sorgu).catch((err) => {
      logger.warn(`CS2 lineup araması başarısız: "${sorgu}" (${err?.message || err})`);
      return { videos: [] };
    });

    for (const video of sonuc.videos || []) {
      if (bulunanlar.has(video.videoId) || !uygunMu(video, harita, tip)) continue;
      bulunanlar.set(video.videoId, {
        videoId: video.videoId,
        baslik: video.title,
        kanal: video.author?.name || 'bilinmiyor',
        saniye: video.duration.seconds,
        url: `https://youtu.be/${video.videoId}`,
        kucukResim: video.thumbnail,
        eslesti: filtre ? filtre.desen.test(video.title) : false,
      });
    }
  }

  // Filtreye uyanlar önce, sonra güvenilir kanallar, sonra kısa klipler.
  const sonuc = [...bulunanlar.values()]
    .sort(
      (a, b) =>
        Number(b.eslesti) - Number(a.eslesti) || kanalPuani(a.kanal) - kanalPuani(b.kanal) || a.saniye - b.saniye
    )
    .slice(0, EN_FAZLA_SONUC);

  onbellek.set(anahtar, { zaman: Date.now(), sonuc });
  return sonuc;
}

module.exports = { lineupAra, EN_FAZLA_SONUC };
