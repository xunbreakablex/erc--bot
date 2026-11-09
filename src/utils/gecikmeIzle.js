// Ana thread (event loop) duraksamalarını ölçer. Ses paketleri bu thread'de 20 ms'de bir zamanlanıyor; ~100 ms'yi
// aşan bir duraksama çalan müzikte takılma olarak duyulabilir. Eşiği aşan duraksamalar log'a yazılır ki sunucuda
// takılma anında ana thread'in gerçekten bloke olup olmadığı görülebilsin.
const { monitorEventLoopDelay } = require('node:perf_hooks');
const logger = require('./logger');

const COZUNURLUK_MS = 10;
const ESIK_MS = Number(process.env.GECIKME_ESIGI_MS) || 100;
const ARALIK_MS = Number(process.env.GECIKME_ARALIGI_MS) || 10_000;

function baslat() {
  const h = monitorEventLoopDelay({ resolution: COZUNURLUK_MS });
  h.enable();

  // Histogram değerleri zamanlayıcı çözünürlüğünü de içerir; gerçek duraksama için o çıkarılır.
  const gercekMs = (ns) => Math.max(0, ns / 1e6 - COZUNURLUK_MS);
  const zamanlayici = setInterval(() => {
    const enFazla = gercekMs(h.max);
    if (enFazla >= ESIK_MS) {
      logger.warn(
        `Ana thread ${Math.round(enFazla)} ms duraksadı (son ${Math.round(ARALIK_MS / 1000)} sn içindeki en uzun; ` +
          `%99: ${Math.round(gercekMs(h.percentile(99)))} ms). Çalan müzikte takılma olabilir.`,
      );
    }
    h.reset();
  }, ARALIK_MS);
  zamanlayici.unref();
  return () => {
    clearInterval(zamanlayici);
    h.disable();
  };
}

module.exports = { baslat };
