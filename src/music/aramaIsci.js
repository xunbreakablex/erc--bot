// yt-search işçisi (worker thread). yt-search YouTube sayfasını (~1 MB) indirip ayrıştırıyor; ayrıştırma işlemci işi
// olduğu için ana thread'de çalışınca ses paketlerini geciktirebiliyordu (zayıf sunucuda duraksama). Burada, ayrı
// bir thread'de çalışır; ana thread yalnızca küçük sonucu alır. Bkz. arama.js.
const { parentPort } = require('node:worker_threads');
const ytSearch = require('yt-search');

// Sonuç ana thread'e kopyalanır; yalnızca kullanılan alanlar ve ilk 20 video gönderilir.
function sadelestir(sonuc) {
  const videos = (sonuc?.videos ?? []).slice(0, 20).map((v) => ({
    videoId: v.videoId,
    url: v.url,
    title: v.title,
    seconds: v.seconds,
    duration: { seconds: v.duration?.seconds },
    author: { name: v.author?.name },
    thumbnail: v.thumbnail,
  }));
  return { videos };
}

parentPort.on('message', async ({ id, sorgu }) => {
  try {
    parentPort.postMessage({ id, sonuc: sadelestir(await ytSearch(sorgu)) });
  } catch (err) {
    parentPort.postMessage({ id, hata: err?.message || String(err) });
  }
});
