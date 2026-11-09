// YouTube araması. yt-search'ün ağır ayrıştırması ayrı bir thread'de (aramaIsci.js) çalışır, böylece ana thread
// (ses paketlerinin zamanlandığı yer) bloke olmaz. İşçi başlatılamazsa ya da düşerse arama eskisi gibi ana
// thread'de yapılır; her aramanın bir zaman aşımı vardır (cevap gelmezse komut sonsuza kadar asılı kalmaz).
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const logger = require('../utils/logger');

const ZAMAN_ASIMI_MS = Number(process.env.ARAMA_ZAMAN_ASIMI_MS) || 15_000;

let isci = null;
let sayac = 0;
const bekleyenler = new Map();

function bekleyenleriReddet(hata) {
  for (const b of bekleyenler.values()) {
    clearTimeout(b.zaman);
    b.reddet(hata);
  }
  bekleyenler.clear();
}

function iscibaslat() {
  const w = new Worker(path.join(__dirname, 'aramaIsci.js'));
  w.unref(); // işçi, botun kapanmasını engellemesin

  w.on('message', ({ id, sonuc, hata }) => {
    const b = bekleyenler.get(id);
    if (!b) return; // zaman aşımına uğramış arama
    bekleyenler.delete(id);
    clearTimeout(b.zaman);
    if (hata) b.reddet(new Error(hata));
    else b.coz(sonuc);
  });
  const dustu = (hata) => {
    if (isci === w) isci = null; // bir sonraki aramada yeniden başlatılır
    bekleyenleriReddet(hata);
  };
  w.on('error', (hata) => {
    logger.error('Arama işçisi hatası', hata);
    dustu(hata);
  });
  w.on('exit', (kod) => {
    if (kod !== 0) logger.warn(`Arama işçisi ${kod} koduyla kapandı`);
    dustu(new Error('Arama işçisi kapandı'));
  });
  return w;
}

// İşçi hiç kullanılamazsa (örn. worker_threads yok) eski davranış: ana thread'de arama.
async function anaThreaddeAra(sorgu) {
  const ytSearch = require('yt-search');
  return ytSearch(sorgu);
}

// Dönen sonuç yt-search'ünkine benzer: `videos[]` içinde videoId, url, title, seconds, duration.seconds,
// author.name ve thumbnail alanları vardır.
function ara(sorgu) {
  return new Promise((coz, reddet) => {
    let w;
    try {
      if (!isci) isci = iscibaslat();
      w = isci;
    } catch (hata) {
      logger.warn(`Arama işçisi başlatılamadı, ana thread'de aranıyor: ${hata.message}`);
      anaThreaddeAra(sorgu).then(coz, reddet);
      return;
    }

    const id = ++sayac;
    const zaman = setTimeout(() => {
      bekleyenler.delete(id);
      reddet(new Error(`Arama ${Math.round(ZAMAN_ASIMI_MS / 1000)} sn içinde cevap vermedi`));
    }, ZAMAN_ASIMI_MS);
    bekleyenler.set(id, { coz, reddet, zaman });
    w.postMessage({ id, sorgu });
  });
}

module.exports = { ara };
