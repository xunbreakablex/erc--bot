const config = require('../config');
const logger = require('../utils/logger');
const remindersRepo = require('../database/repositories/remindersRepo');
const inflation = require('../utils/inflation');

const REMINDER_POLL_INTERVAL_MS = 30_000;
const INFLATION_CHECK_INTERVAL_MS = 10 * 60_000;

function startReminderPolling(client) {
  setInterval(async () => {
    const due = remindersRepo.getDueReminders();
    for (const reminder of due) {
      remindersRepo.deleteReminder(reminder.id);
      try {
        const channel = await client.channels.fetch(reminder.channel_id);
        if (channel?.isTextBased()) {
          await channel.send(`⏰ <@${reminder.user_id}> hatırlatma: ${reminder.message}`);
        }
      } catch (err) {
        logger.error('Failed to deliver reminder', reminder.id, err);
      }
    }
  }, REMINDER_POLL_INTERVAL_MS);
}

function startInflationScheduler() {
  const kontrol = () => {
    try {
      const sonuc = inflation.runIfDue();
      if (sonuc) {
        logger.info(`Enflasyon uygulandı: %${(sonuc.rate * 100).toFixed(1)}, etkilenen hesap: ${sonuc.affected}`);
      }
    } catch (err) {
      logger.error('Enflasyon uygulanamadı', err);
    }
  };
  kontrol();
  setInterval(kontrol, INFLATION_CHECK_INTERVAL_MS);
}

module.exports = {
  name: 'ready',
  once: true,
  execute(client) {
    logger.info(`Logged in as ${client.user.tag}`);
    // Botun hangi sunucularda olduğunu görmek, "şu sunucuda çalışmıyor" tipi sorunları hızlı ayıklamayı sağlıyor.
    const sunucular = client.guilds.cache.map((g) => `${g.name} (${g.id})`);
    logger.info(`Bulunduğu sunucular (${sunucular.length}): ${sunucular.join(', ') || 'yok'}`);
    client.user.setActivity(`${config.prefix}help`);
    // Ses takılmalarını görebilmek için ana thread duraksamaları (eşik aşılınca) log'a yazılır.
    require('../utils/gecikmeIzle').baslat();
    startReminderPolling(client);
    startInflationScheduler();
  },
};
