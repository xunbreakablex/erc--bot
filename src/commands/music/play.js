const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getInfo, getPlaylist, kisaHata, MAX_PLAYLIST } = require('../../music/ytdlp');
const { ara } = require('../../music/arama');
const { errorEmbed, successEmbed, infoEmbed } = require('../../utils/embeds');
const musicManager = require('../../music/musicManager');
const logger = require('../../utils/logger');

function isYoutubeUrl(str) {
  return /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(str);
}

// Sadece açık playlist linkleri listeye çevrilir; içinde list= olan izleme linkleri tek şarkı sayılır.
function isPlaylistUrl(str) {
  return /^(https?:\/\/)?(www\.|m\.|music\.)?youtube\.com\/playlist\?/i.test(str);
}

async function resolveTracks(query) {
  if (isPlaylistUrl(query)) {
    return getPlaylist(query);
  }
  if (isYoutubeUrl(query)) {
    return [await getInfo(query)];
  }
  // Arama ayrı thread'de (ana thread bloke olmasın), zaman aşımı korumalı.
  const result = await ara(query);
  const video = result.videos?.[0];
  return video ? [{ url: video.url, title: video.title, duration: video.seconds || null }] : [];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription(`YouTube'dan şarkı çal. Şarkı adı, video linki ya da playlist linki (en fazla ${MAX_PLAYLIST} şarkı) verebilirsin.`)
    .addStringOption((opt) => opt.setName('sarki').setDescription('Şarkı adı, YouTube linki veya playlist linki').setRequired(true)),
  async execute(interaction) {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({
        embeds: [errorEmbed('Kanalda yoksun ki dayı, önce bir sesli kanala gir.')],
        ephemeral: true,
      });
      return;
    }

    // İzin eksikse bağlantı sessizce takılıyor; sebebi baştan söylemek daha net.
    const izinler = voiceChannel.permissionsFor(interaction.guild.members.me);
    const eksikler = [
      [PermissionFlagsBits.ViewChannel, 'Kanalı Görüntüle'],
      [PermissionFlagsBits.Connect, 'Bağlan'],
      [PermissionFlagsBits.Speak, 'Konuş'],
    ]
      .filter(([bayrak]) => !izinler?.has(bayrak))
      .map(([, ad]) => ad);

    if (eksikler.length > 0) {
      logger.warn(`Ses izni eksik (#${voiceChannel.name}, sunucu: ${interaction.guild?.name}): ${eksikler.join(', ')}`);
      await interaction.reply({
        embeds: [errorEmbed(`**${voiceChannel.name}** kanalında şu iznim yok: **${eksikler.join(', ')}**`)],
      });
      return;
    }

    // Kanal dolu olsa bile "Üyeleri Taşı" izni olan bot girebilir.
    if (voiceChannel.userLimit > 0 && voiceChannel.members.size >= voiceChannel.userLimit && !izinler.has(PermissionFlagsBits.MoveMembers)) {
      logger.warn(`Ses kanalı dolu (#${voiceChannel.name}, sunucu: ${interaction.guild?.name})`);
      await interaction.reply({ embeds: [errorEmbed(`**${voiceChannel.name}** dolu, içeri giremiyorum.`)] });
      return;
    }

    const query = interaction.options.getString('sarki', true);
    await interaction.deferReply();

    logger.info(`!play — sunucu: ${interaction.guild?.name}, kullanıcı: ${interaction.user.tag}, sorgu: "${query}"`);

    let tracks;
    const cozumlemeBas = Date.now();
    try {
      tracks = await resolveTracks(query);
      logger.info(`!play çözümleme ${Date.now() - cozumlemeBas} ms (sorgu: "${query}")`);
    } catch (err) {
      // Hata yutulunca "çekemedim" mesajının sebebi loglarda görünmüyordu.
      logger.error(`Şarkı çözümlenemedi (sorgu: "${query}")`, err);
      // Bot doğrulamasında "başka bir şey dene" yanıltıcı: hiçbir şarkı çekilemez, sebebi söylenir.
      const bot = /Sign in to confirm you.?re not a bot/i.test(String(err?.message));
      await interaction.editReply({
        embeds: [errorEmbed(bot ? `Şarkıyı çekemedim: ${kisaHata(err)}.` : 'Şarkıyı bulamadım ya da çekemedim, başka bir şey dene.')],
      });
      return;
    }

    if (tracks.length === 0) {
      await interaction.editReply({ embeds: [errorEmbed('Bu aramaya bir şey bulamadım.')] });
      return;
    }

    const requestedBy = interaction.user.tag;
    let startedImmediately;
    try {
      startedImmediately = musicManager.enqueueMany(
        interaction.guild,
        voiceChannel,
        interaction.channel,
        tracks.map((t) => ({ ...t, requestedBy }))
      );
    } catch (err) {
      // Sesli kanala bağlanma hatası (izin, bölge, kapasite) buradan görünür olsun.
      logger.error(`Sesli kanala bağlanılamadı (#${voiceChannel.name}, sunucu: ${interaction.guild?.name})`, err);
      await interaction.editReply({ embeds: [errorEmbed('Sesli kanala bağlanamadım. İznim var mı bir bak.')] });
      return;
    }

    if (tracks.length > 1) {
      await interaction.editReply({
        embeds: [successEmbed(`📃 Playlistten **${tracks.length}** şarkı sıraya eklendi. İlki: **${tracks[0].title}**`)],
      });
      return;
    }

    const { title } = tracks[0];
    await interaction.editReply({
      embeds: [
        startedImmediately
          ? successEmbed(`🎶 Şimdi çalıyor: **${title}**`)
          : infoEmbed(`➕ Sıraya attım kanka, biraz bekle: **${title}**`),
      ],
    });
  },
};
