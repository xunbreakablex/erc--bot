process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || require('ffmpeg-static');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  demuxProbe,
  StreamType,
} = require('@discordjs/voice');
const { PermissionFlagsBits } = require('discord.js');
const ytdlp = require('./ytdlp');
const panel = require('./panel');
const kalite = require('./kalite');
const paketOnbellegi = require('./paketOnbellegi');
const logger = require('../utils/logger');

const LOOP_MODLARI = ['kapali', 'sarki', 'kuyruk'];
const BOS_KANAL_BEKLEME_MS = 30_000;
const SIRA_BITTI_BEKLEME_MS = 15_000;
// Otomatik oynatma aynı şarkıları döndürmesin diye son çalınanlar hatırlanıyor.
const CALINAN_HAFIZA = 200;
// Mix listelerinde ara sıra 1 saatlik derlemeler çıkıyor; otomatik oynatmada onlar atlanıyor.
const OTOMATIK_MAX_SURE_SN = 15 * 60;
const OTOMATIK_EKLEYEN = '♾️ Otomatik oynatma';

// yt-dlp takılırsa oynatıcı sonsuza kadar sessiz beklerdi; ilk veri bu sürede gelmezse şarkı hatalı sayılır.
// Yavaş/yoğun sunucuda yt-dlp'nin imza çözümü bile 10-20 sn sürebildiği için süre cömert tutuluyor.
const ILK_VERI_BEKLEME_MS = 45_000;

// Akışın ilk baytlarına bakıp türünü (WebM/Ogg Opus ya da başka) tespit eder; zaman aşımı korumalı.
function akisiTani(stream) {
  let zamanlayici;
  const zamanAsimi = new Promise((_, reddet) => {
    zamanlayici = setTimeout(() => reddet(new Error('akış zamanında veri vermedi')), ILK_VERI_BEKLEME_MS);
  });
  return Promise.race([demuxProbe(stream), zamanAsimi]).finally(() => clearTimeout(zamanlayici));
}

const guildStates = new Map();

function getState(guildId) {
  return guildStates.get(guildId);
}

// @discordjs/voice içindeki ağ aşamaları (NetworkingStatusCode dışa aktarılmadığı için elle eşleniyor).
const AG_ASAMALARI = ['ws-aciliyor', 'kimlik-dogrulama', 'udp-el-sikisma', 'protokol-secimi', 'hazir', 'yeniden-baglaniyor', 'kapali'];

// Bağlantı takılınca hangi adımda kaldığını ve hangi ses sunucusuna gidildiğini gösterir.
function agAsamasi(connection) {
  const networking = connection.state?.networking;
  const durum = networking?.state;
  if (!durum) return 'ağ katmanı hiç başlamadı (ses sunucusu bilgisi gelmedi)';
  const asama = AG_ASAMALARI[durum.code] ?? durum.code;
  return `ağ aşaması: ${asama}, ses sunucusu: ${durum.connectionOptions?.endpoint ?? 'bilinmiyor'}`;
}

// Panel mesajı hep en altta dursun diye şarkı değişince eskisi silinip yenisi gönderiliyor.
async function sendPanel(state) {
  const eski = state.panelMessage;
  state.panelMessage = null;
  if (eski) await eski.delete().catch(() => {});
  if (!state.current) return;

  try {
    state.panelMessage = await state.textChannel.send(panel.build(state));
  } catch (err) {
    logger.error('Müzik paneli gönderilemedi', err);
  }
}

// Duraklatma, döngü, karıştırma gibi durum değişiklikleri panelde yerinde güncelleniyor.
async function refreshPanel(guildId) {
  const state = getState(guildId);
  if (!state?.panelMessage || !state.current) return;
  await state.panelMessage.edit(panel.build(state)).catch(() => {});
}

function removePanel(state) {
  const mesaj = state.panelMessage;
  state.panelMessage = null;
  if (mesaj) mesaj.delete().catch(() => {});
}

function destroyState(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;
  guildStates.delete(guildId);
  clearTimeout(state.leaveTimer);
  clearTimeout(state.queueBittiTimer);
  if (state.seekDurum) {
    clearTimeout(state.seekDurum.timer);
    state.seekDurum.bekleyenler.forEach((coz) => coz(false));
    state.seekDurum = null;
  }
  removePanel(state);
  state.onbellek?.temizle();
  state.onbellek = null;
  try {
    state.killStream?.();
    state.player.stop(true);
    state.connection.destroy();
  } catch {
    // bağlantı zaten kapanmış olabilir, önemli değil
  }
}

function requeueFinished(state) {
  const bitti = state.current;
  if (!bitti || bitti.failed) return;

  if (state.loop === 'sarki' && !state.skipRequested) {
    state.queue.unshift(bitti);
  } else if (state.loop === 'kuyruk') {
    state.queue.push(bitti);
  }
}

// Bazı ağlardan Discord'un otomatik seçtiği ses sunucusuna (özellikle c-otp*.discord.media) UDP
// paketleri geçmiyor; bağlantı "udp-el-sikisma" aşamasında ölüyor. Elle bölge seçilince farklı bir
// ses sunucusuna düşüldüğü için sorun kalkıyor. Bot da aynı şeyi kendisi yapabilsin diye
// başarısız bağlantıdan sonra kanalın bölgesi sırayla bu adaylara çevrilip tekrar deneniyor.
const YEDEK_BOLGELER = (process.env.VOICE_REGIONS || 'rotterdam,frankfurt,milan,madrid')
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean);

const BAGLANTI_BEKLEME_MS = 20_000;

async function bolgeDegistirVeYenidenBagla(state, guildId) {
  const kanal = state.voiceChannel;
  if (!kanal) return false;

  const bolge = YEDEK_BOLGELER.find((b) => !state.denenenBolgeler.includes(b));
  if (!bolge) return false;

  const izinler = kanal.permissionsFor(kanal.guild.members.me);
  if (!izinler?.has(PermissionFlagsBits.ManageChannels)) {
    logger.warn(`Ses bölgesi değiştirilemedi: "Kanalları Yönet" izni yok (#${kanal.name}, ${kanal.guild.name})`);
    return false;
  }

  state.denenenBolgeler.push(bolge);
  logger.info(`Ses bölgesi "${bolge}" olarak deneniyor (#${kanal.name}, ${kanal.guild.name})`);

  try {
    await kanal.setRTCRegion(bolge, 'Otomatik ses sunucusuna bağlanılamadı');
  } catch (err) {
    logger.error(`Ses bölgesi "${bolge}" olarak ayarlanamadı`, err);
    return false;
  }

  try {
    state.connection.destroy();
  } catch {
    // zaten kapanmış olabilir
  }

  state.connection = baglantiKur(kanal.guild, kanal, state.player);
  return true;
}

async function baglantiyiBekle(state, guildId) {
  for (;;) {
    try {
      await entersState(state.connection, VoiceConnectionStatus.Ready, BAGLANTI_BEKLEME_MS);
      return true;
    } catch (err) {
      logger.error(
        `Sesli kanala bağlanılamadı (sunucu: ${guildId}, durum: ${state.connection.state.status}, ${agAsamasi(state.connection)})`,
        err
      );

      // State bu arada yok edilmişse (stop, kanal boşaldı vb.) uğraşmayı bırak.
      if (getState(guildId) !== state) return false;

      if (await bolgeDegistirVeYenidenBagla(state, guildId)) continue;

      const sebep = state.denenenBolgeler.length
        ? `Denediğim bölgeler: ${state.denenenBolgeler.join(', ')}. Kanalın **Bölge Geçersiz Kılma** ayarını elle değiştirmeyi dene.`
        : 'Kanalda **Bağlan**, **Konuş** ve bölge değiştirebilmem için **Kanalları Yönet** iznim var mı bir bak.';
      state.textChannel.send(`❌ Sesli kanala bağlanamadım. ${sebep}`).catch(() => {});
      destroyState(guildId);
      return false;
    }
  }
}

// Bir şarkının Mix listesi tek sefer çekilip saklanıyor; şarkı çalarken önceden istenince sıradakine
// geçiş beklemesiz oluyor. Hata olursa önbellek bırakılıyor ki sonraki denemede tekrar çekilsin.
function mixGetir(state, seed) {
  const id = ytdlp.videoIdOf(seed?.url);
  if (!id) return Promise.resolve([]);

  if (state.mixOnbellek?.id !== id) {
    const onbellek = { id, adaylar: null };
    onbellek.adaylar = ytdlp.getMix(id).catch((err) => {
      logger.error(`Otomatik oynatma için Mix listesi çekilemedi (video: ${id})`, err);
      if (state.mixOnbellek === onbellek) state.mixOnbellek = null;
      return [];
    });
    state.mixOnbellek = onbellek;
  }
  return state.mixOnbellek.adaylar;
}

// YouTube'un otomatik oynatmasındaki gibi son çalınan şarkının Mix'inden henüz çalınmamış ilk şarkıyı seçer.
async function otomatikSarkiBul(state) {
  const adaylar = await mixGetir(state, state.sonCalinan);
  const yeniler = adaylar.filter((t) => {
    const id = ytdlp.videoIdOf(t.url);
    return id && !state.calinanlar.includes(id) && !(t.duration > OTOMATIK_MAX_SURE_SN);
  });
  // Slowed/nightcore/8D/karaoke gibi parçalar elenir, resmî kaynaklar (Topic, VEVO, Official) öne alınır.
  const secilen = kalite.enIyiniSec(yeniler);
  return secilen ? { ...secilen, requestedBy: OTOMATIK_EKLEYEN } : null;
}

function otomatikOnYukle(state) {
  if (state.autoplay && state.queue.length === 0 && state.sonCalinan) mixGetir(state, state.sonCalinan);
}

function calinanlaraEkle(state, track) {
  const id = ytdlp.videoIdOf(track.url);
  if (!id) return;
  state.calinanlar = state.calinanlar.filter((c) => c !== id);
  state.calinanlar.push(id);
  if (state.calinanlar.length > CALINAN_HAFIZA) state.calinanlar.shift();
}

async function playNext(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  requeueFinished(state);
  state.skipRequested = false;

  let next = state.queue.shift();
  if (!next && state.autoplay && state.sonCalinan) {
    // Arama sürerken /play gelirse enqueueMany ayrıca playNext başlatmasın diye bayrak tutuluyor.
    state.current = null;
    state.otomatikAraniyor = true;
    const oneri = await otomatikSarkiBul(state);
    state.otomatikAraniyor = false;
    if (getState(guildId) !== state) return;

    // Bu arada biri şarkı eklediyse önce onunki çalsın; otomatik oynatma kapatıldıysa öneri atılır.
    next = state.queue.shift() ?? (state.autoplay ? oneri : null);
    if (!next && state.autoplay) {
      state.textChannel.send('♾️ Otomatik oynatma için yeni bir şarkı bulamadım.').catch(() => {});
    }
  }
  if (!next) {
    state.current = null;
    // Sıra bitince hemen çıkmıyoruz; kısa süre içinde yeni şarkı eklenirse (enqueueMany bu timer'ı
    // temizler) kanalda kalınmaya devam edilsin diye bekliyoruz.
    clearTimeout(state.queueBittiTimer);
    state.queueBittiTimer = setTimeout(() => {
      if (getState(guildId) !== state) return;
      if (state.current || state.queue.length > 0) return;
      destroyState(guildId);
    }, SIRA_BITTI_BEKLEME_MS);
    return;
  }

  state.current = next;
  // Döngüde aynı şarkı nesnesi yeniden çalınıyor; önceki seek'in ofseti süre göstergesini bozmasın.
  next.seekOffsetMs = 0;
  state.sonCalinan = next;
  calinanlaraEkle(state, next);
  state.killStream?.();

  // Önceki şarkının paket önbelleği: aynı şarkı yeniden çalınıyorsa (tekrar modu) YouTube'a gitmeden oradan çalınır,
  // değilse bellek bırakılır.
  let tekrarOnbellek = null;
  if (state.onbellek) {
    const onb = state.onbellek;
    if (onb.url === next.url && onb.tamamlandi && !onb.eksik && !next.failed) {
      tekrarOnbellek = onb;
    } else {
      onb.temizle();
      state.onbellek = null;
    }
  }

  // Bağlantı hazır olmadan çalmaya başlarsak ses gitmiyor ve hiçbir hata da çıkmıyor.
  if (!(await baglantiyiBekle(state, guildId))) return;

  try {
    if (tekrarOnbellek) {
      if (getState(guildId) !== state || state.current !== next || state.skipRequested || tekrarOnbellek.temizlendi) {
        if (getState(guildId) === state && state.current === next) playNext(guildId);
        return;
      }
      logger.info(`Önbellekten tekrar çalınıyor (YouTube'a gidilmedi) [${next.title}]`);
      state.player.play(createAudioResource(tekrarOnbellek.okuyucu(0), { inputType: StreamType.Opus }));
      sendPanel(state);
      otomatikOnYukle(state);
      return;
    }

    const { stream, kill } = ytdlp.createStream(next.url, (err) => {
      logger.error('yt-dlp hatası', err);
      // Döngü modunda bozuk şarkı sonsuza kadar yeniden denenmesin.
      next.failed = true;
      if (state.current === next) {
        state.textChannel.send(`⚠️ **${next.title}** çekilemedi: ${ytdlp.kisaHata(err)}.`).catch(() => {});
      }
    });
    state.killStream = kill;

    // Akışın türü ilk baytlardan anlaşılır: YouTube Opus (WebM) verirse paketler Discord'a olduğu gibi
    // gider (ffmpeg'le çözüp yeniden kodlama yok); başka bir biçimse ffmpeg'e dönüştürtülür.
    const { stream: kaynak, type } = await akisiTani(stream);

    // Tanıma beklenirken şarkı atlandıysa ya da bağlantı kapandıysa bu akışı çalma.
    if (getState(guildId) !== state || state.current !== next || state.skipRequested) {
      kill();
      if (getState(guildId) === state && state.current === next) playNext(guildId);
      return;
    }

    // "webm/opus" = dönüştürmesiz doğrudan geçiş; "arbitrary" = ffmpeg ile dönüştürülen yedek yol.
    let resource;
    if (type === StreamType.WebmOpus && paketOnbellegi.onbellegeUygunMu(next.duration)) {
      // Opus paketleri bellekte tutulur (süre sınırın altındaysa): çalma ve sarma bu diziden yapılır, sarma için
      // YouTube'a yeni istek gerekmez. Uzun içerikler ya da süresi bilinmeyenler aşağıdaki gibi akıştan çalınır.
      const onb = paketOnbellegi.onbellekKur(next.url, kaynak, kill);
      state.onbellek = onb;
      logger.info(`Akış türü [${next.title}]: ${type} (bellek önbelleği açık)`);
      resource = createAudioResource(onb.okuyucu(0), { inputType: StreamType.Opus });
    } else {
      logger.info(`Akış türü [${next.title}]: ${type}`);
      resource = createAudioResource(kaynak, { inputType: type });
    }
    state.player.play(resource);
    sendPanel(state);
    otomatikOnYukle(state);
  } catch (err) {
    logger.error('Şarkı çalınırken hata oluştu', err);
    state.killStream?.();
    next.failed = true;
    state.textChannel.send(`⚠️ **${next.title}** çalınamadı, sıradakine geçiyorum.`).catch(() => {});
    playNext(guildId);
  }
}

// Bağlantı hem ilk kurulumda hem de bölge değişiminden sonra aynı şekilde kuruluyor.
function baglantiKur(guild, voiceChannel, player) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
  });

  connection.subscribe(player);

  // Bağlantı durumları, "çalmıyor ama hata da yok" vakalarını ayıklamak için loglanıyor.
  connection.on('stateChange', (eski, yeni) => {
    // Hazır olan bağlantının ses sunucusunu da yazıyoruz; çalışan ve çalışmayan sunucuları kıyaslamayı sağlıyor.
    const ek = yeni.status === VoiceConnectionStatus.Ready ? ` (${agAsamasi(connection)})` : '';
    logger.info(`Ses bağlantısı [${guild.name}]: ${eski.status} -> ${yeni.status}${ek}`);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroyState(guild.id);
    }
  });

  return connection;
}

function createState(guild, voiceChannel, textChannel) {
  // Varsayılan 5 kare (~100 ms) veri gelmezse oynatıcı şarkıyı bitmiş sayıp Idle'a geçiyor ve playNext
  // sıradakine atlıyor. Ağ/yt-dlp kısa takılınca şarkı atlamasın diye tolerans yükseltildi; şarkı gerçekten
  // bittiğinde akış kapandığı için Idle yine anında tetiklenir.
  const player = createAudioPlayer({ behaviors: { maxMissedFrames: 250 } });
  const connection = baglantiKur(guild, voiceChannel, player);

  const state = {
    connection,
    player,
    queue: [],
    current: null,
    textChannel,
    voiceChannel,
    loop: 'kapali',
    autoplay: false,
    otomatikAraniyor: false,
    sonCalinan: null,
    calinanlar: [],
    mixOnbellek: null,
    skipRequested: false,
    leaveTimer: null,
    queueBittiTimer: null,
    panelMessage: null,
    onbellek: null,
    denenenBolgeler: [],
  };

  player.on('stateChange', (eski, yeni) => {
    logger.info(`Oynatıcı [${guild.name}]: ${eski.status} -> ${yeni.status}`);
  });

  player.on(AudioPlayerStatus.Idle, () => playNext(guild.id));
  // Hatadan sonra oynatıcı zaten Idle'a geçip playNext'i tetikliyor; burada tekrar çağırmak şarkı atlatır.
  player.on('error', (err) => {
    logger.error('Ses oynatıcı hatası', err);
    if (state.current) {
      state.current.failed = true;
      textChannel.send(`⚠️ **${state.current.title}** çalınırken hata oldu (${err.message}), sıradakine geçiyorum.`).catch(() => {});
    }
  });

  guildStates.set(guild.id, state);
  return state;
}

function enqueueMany(guild, voiceChannel, textChannel, tracks) {
  const state = guildStates.get(guild.id) || createState(guild, voiceChannel, textChannel);
  const willStartImmediately = !state.current && state.queue.length === 0 && !state.otomatikAraniyor;

  state.queue.push(...tracks);

  if (willStartImmediately) {
    clearTimeout(state.queueBittiTimer);
    state.queueBittiTimer = null;
    playNext(guild.id);
  }

  return willStartImmediately;
}

function enqueue(guild, voiceChannel, textChannel, track) {
  return enqueueMany(guild, voiceChannel, textChannel, [track]);
}

function skip(guildId) {
  const state = getState(guildId);
  if (!state) return;
  state.skipRequested = true;
  state.player.stop();
}

// Oynatıcı zaten Idle'sa player.stop() hiçbir olay tetiklemiyor ve bot kanalda asılı kalıyordu;
// bu yüzden kuyruğun boşalmasını beklemeden bağlantıyı doğrudan kapatıyoruz.
function stop(guildId) {
  const state = getState(guildId);
  if (!state) return;
  state.queue = [];
  state.loop = 'kapali';
  state.skipRequested = true;
  state.current = null;
  destroyState(guildId);
}

function pause(guildId) {
  const state = getState(guildId);
  if (!state) return;
  state.player.pause();
  refreshPanel(guildId);
}

function resume(guildId) {
  const state = getState(guildId);
  if (!state) return;
  state.player.unpause();
  refreshPanel(guildId);
}

// Çalan şarkıyı belirtilen saniyeden itibaren yeniden başlatır.
// Eski akış, yeni akış hazır olana kadar çalmaya devam eder. Önceden hemen öldürülüyordu: yeni akış
// (yt-dlp + ffmpeg) saniyelerce gelmeyince oynatıcı boşa düşüp Idle oluyor, playNext de şarkıyı atlatıyordu.
async function seek(guildId, saniye) {
  const state = getState(guildId);
  if (!state?.current) return false;

  const hedef = state.current;

  // Şarkı bellekte tutuluyorsa sarma, paket dizisinde konum değiştirmekten ibaret: ağ yok, ffmpeg yok, anında.
  const onb = state.onbellek;
  if (onb && !onb.temizlendi && !onb.eksik && onb.url === hedef.url) {
    let index = Math.round((saniye * 1000) / paketOnbellegi.PAKET_MS);
    // Şarkının sonunu aşan hedef son pakete çekilir (şarkı bitip sıradakine geçilir); inmemiş bölüme sarılırsa
    // okuyucu paketler gelene kadar bekler.
    if (onb.tamamlandi) index = Math.min(index, Math.max(0, onb.paketler.length - 1));
    hedef.seekOffsetMs = index * paketOnbellegi.PAKET_MS;
    state.player.play(createAudioResource(onb.okuyucu(index), { inputType: StreamType.Opus }));
    refreshPanel(guildId);
    return true;
  }

  let akis;
  let girdi;
  try {
    // Geri çağrı yalnızca akış başladıktan SONRAKİ kopmalar içindir; başlatma hataları fırlatılıp aşağıda yakalanır.
    akis = await ytdlp.createSeekStream(hedef.url, saniye, (err) => {
      logger.error('yt-dlp/ffmpeg seek hatası (akış başladıktan sonra)', err);
      if (state.current === hedef) {
        state.textChannel.send(`⚠️ **${hedef.title}** için saniyeye gidilemedi: ${ytdlp.kisaHata(err)}.`).catch(() => {});
      }
    });
    // Opus paketleri kopyalandıysa (Ogg) türü tespit edilip olduğu gibi gönderilir; yoksa ham PCM'dir.
    girdi = akis.opus ? await akisiTani(akis.stream) : { stream: akis.stream, type: StreamType.Raw };
  } catch (err) {
    // Yeni akış başlatılamadı: eski akışa dokunulmadı, çalan şarkı kesilmeden devam ediyor.
    akis?.kill();
    logger.error('Seek akışı başlatılamadı (çalan şarkı devam ediyor)', err);
    if (state.current === hedef) {
      state.textChannel.send(`⚠️ **${hedef.title}** için saniyeye gidilemedi: ${ytdlp.kisaHata(err)}.`).catch(() => {});
    }
    return false;
  }

  // Bu arada şarkı değişmiş ya da state yok edilmişse yeni akışı hemen kapat.
  if (getState(guildId) !== state || state.current !== hedef) {
    akis.kill();
    return false;
  }

  // Yeni akış hazır: önce oynatıcıya veriyoruz (eski kaynağı o bırakır), sonra eski süreci öldürüyoruz.
  const eskiKill = state.killStream;
  state.killStream = akis.kill;
  hedef.seekOffsetMs = saniye * 1000;
  const resource = createAudioResource(girdi.stream, { inputType: girdi.type });
  state.player.play(resource);
  eskiKill?.();
  refreshPanel(guildId);
  return true;
}

// Hızlı art arda tıklamalar tek bir seek'e birleştirilir: her tıklama ayrı yt-dlp/ffmpeg başlatırsa
// süreçler birbirine girip ses donuyordu. Hedef saniye tıklamalar boyunca birikir, kısa bir sessizlikten
// sonra bir kez gidilir; seek sürerken gelen tıklamalar bitince bir tur daha çalıştırılır.
const SEEK_BEKLEME_MS = 500;

async function seekDongusu(guildId, state, durum) {
  durum.calisiyor = true;
  for (;;) {
    const hedef = durum.hedef;
    const bekleyenler = durum.bekleyenler;
    durum.bekleyenler = [];
    durum.degisti = false;

    let sonuc = false;
    // Bekleme sırasında şarkı değiştiyse eski şarkının hedefine gitmeyelim.
    if (getState(guildId) === state && state.current === durum.parca) {
      try {
        sonuc = await seek(guildId, hedef);
      } catch (err) {
        logger.error('Seek işlenemedi', err);
      }
    }
    bekleyenler.forEach((coz) => coz(sonuc));

    if (!durum.degisti) break;
  }
  if (state.seekDurum === durum) state.seekDurum = null;
}

// Çalma konumunu `delta` saniye kaydırır (negatif = geri). Dönen söz, birleştirilen seek bitince çözülür.
function seekBy(guildId, delta) {
  const state = getState(guildId);
  if (!state?.current) return Promise.resolve(false);

  if (!state.seekDurum) {
    state.seekDurum = {
      parca: state.current,
      hedef: panel.elapsedSaniye(state),
      timer: null,
      bekleyenler: [],
      calisiyor: false,
      degisti: false,
    };
  }
  const durum = state.seekDurum;

  const sure = state.current.duration;
  let hedef = Math.max(0, durum.hedef + delta);
  if (Number.isFinite(sure)) hedef = Math.min(hedef, Math.max(0, sure - 2));
  durum.hedef = hedef;

  return new Promise((coz) => {
    durum.bekleyenler.push(coz);
    if (durum.calisiyor) {
      durum.degisti = true;
      return;
    }
    clearTimeout(durum.timer);
    durum.timer = setTimeout(() => seekDongusu(guildId, state, durum), SEEK_BEKLEME_MS);
  });
}

function setLoop(guildId, mod) {
  const state = getState(guildId);
  if (!state) return null;
  const yeniMod = mod ?? LOOP_MODLARI[(LOOP_MODLARI.indexOf(state.loop) + 1) % LOOP_MODLARI.length];
  state.loop = yeniMod;
  refreshPanel(guildId);
  return yeniMod;
}

// Açıkken kuyruk bitince YouTube'un otomatik oynatması gibi benzer şarkılarla devam edilir.
function toggleAutoplay(guildId) {
  const state = getState(guildId);
  if (!state) return null;
  state.autoplay = !state.autoplay;
  otomatikOnYukle(state);
  refreshPanel(guildId);
  return state.autoplay;
}

function shuffle(guildId) {
  const state = getState(guildId);
  if (!state) return 0;
  const q = state.queue;
  for (let i = q.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [q[i], q[j]] = [q[j], q[i]];
  }
  refreshPanel(guildId);
  return q.length;
}

function insanSayisi(kanal) {
  return kanal.members.filter((m) => !m.user.bot).size;
}

// Kısa kopmalarda kuyruk kaybolmasın diye kanal boşalınca hemen değil, bekleme süresinden sonra çıkılır.
function checkEmptyChannel(guild) {
  const state = getState(guild.id);
  if (!state) return;

  const kanal = guild.members.me?.voice?.channel;
  if (!kanal) return;

  if (insanSayisi(kanal) > 0) {
    clearTimeout(state.leaveTimer);
    state.leaveTimer = null;
    return;
  }
  if (state.leaveTimer) return;

  state.leaveTimer = setTimeout(() => {
    state.leaveTimer = null;
    if (getState(guild.id) !== state) return;
    const guncelKanal = guild.members.me?.voice?.channel;
    if (guncelKanal && insanSayisi(guncelKanal) > 0) return;

    state.textChannel.send('👋 Kanalda kimse kalmadı, ben de kalkıyorum.').catch(() => {});
    destroyState(guild.id);
  }, BOS_KANAL_BEKLEME_MS);
}

module.exports = {
  LOOP_MODLARI,
  enqueue,
  enqueueMany,
  getState,
  skip,
  stop,
  pause,
  resume,
  seek,
  seekBy,
  setLoop,
  toggleAutoplay,
  shuffle,
  checkEmptyChannel,
  refreshPanel,
};
