// fetch-descriptions.js
// Запуск: node fetch-descriptions.js

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const { CLIENT_ID, CLIENT_SECRET } = require('./config.local.js');

const CHANNELS = [
  { id: 'UCw2B_oHEJsoAJO6wRC3urcg', name: 'Варюсь в симрейсингу' },
  { id: 'UCpycdCHaP8MFmNhgWxLsHdA', name: 'TSP simracing' },
  { id: 'UC7vwQkUFAlSrRiWm9fT2ArQ', name: 'UARTA' },
  { id: 'UCFTskZpg8jYJtI4wx_8BYtA', name: 'McLeon UA Racing' },
  { id: 'UCG5r7F6k5DMSApRFrIQIXDw', name: 'Scuderia Troieshchyna' },
  { id: 'UCG-Jdv1tcTRIim_Fg3ckRqw', name: 'KMAMK Ukraine' },
  { id: 'UCxI1SpueG9BmcyGbSoqOUNg', name: 'Dominik Khoroshavin' },
  { id: 'UCHmtNov-5ZaNGrvslpJSlOw', name: 'GRC' },
  { id: 'UCY_mx-H_eQIAUG9amd8r-3Q', name: '7DRIVE Racing' },
  { id: 'UCU-6dT4XzXuuDS8YXccrQmA', name: 'ArTy Simracing / Artem Makarov' },
  { id: 'UCTT4H2Nb8L3jBV3MadpmRBg', name: 'Artem Sova' },
  { id: 'UCSxB9h_41zt9JJap5fs-UzQ', name: 'Digital Autosport of Ukraine' },
  { id: 'UCZCW1c6_W6rZEcQTugggAkQ', name: 'GTUKR' },
  { id: 'UCNZDuL06zgyUgrNKvb3x5Og', name: 'MELTON RACE' },
  { id: 'UCOAanTZR56k1Y1QnZ8KTHXA', name: 'Slick Racing Ukraine' },
  { id: 'UCUPNgTHtcLQKU6MOss1tciA', name: 'Racer Kepka Den' },
  { id: 'UCXW85ofk4VuIfm-CO3UZEdw', name: 'SKF Racing Hub' },
  { id: 'UCAJY-oXmgcxikf4vIALFk-Q', name: 'Tony SKF' },
  { id: 'UC8awUez5PmibWG2vandtzLw', name: 'GranTourist' },
  { id: 'UCwJo0cmhCe2dZ9U78otH5SA', name: 'YUREV0' },
  // ── Симрейсинг (міжнародні) ──────────────────────────────────────
  { id: 'UCq-ylUNa9RoTK5jr6TBOYag', name: 'Jimmy Broadbent' },
  { id: 'UC2P9GUUfFXhq-hiAxC1FTPQ', name: 'Aris.Drives' },
  { id: 'UCIn-ILfb4I5x-_2GV2zIiyg', name: 'Asetek Racing' },
  { id: 'UCgrlBI6OzHgVA-iVupI4TuQ', name: 'Assetto Corsa Official' },
  { id: 'UCwJXXoaCgiAlXfZiuy4lM9g', name: 'Fuchsklasse' },
  { id: 'UCUPNgTHtcLQKU6MOss1tciA', name: 'Racer Kepka Den' },
];

const VIDEOS_PER_CHANNEL = 5;

async function getAuthClient() {
  const auth = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    'http://localhost:3456/auth/callback'
  );
  const token = JSON.parse(fs.readFileSync(path.join(__dirname, 'tokens.json')));
  auth.setCredentials(token);
  return auth;
}

async function getChannelVideos(youtube, channelId, maxResults = 5) {
  const channelRes = await youtube.channels.list({
    part: ['contentDetails'],
    id: [channelId],
  });

  const uploadsPlaylistId =
    channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

  if (!uploadsPlaylistId) return [];

  const playlistRes = await youtube.playlistItems.list({
    part: ['snippet'],
    playlistId: uploadsPlaylistId,
    maxResults,
  });

  const videoIds = playlistRes.data.items.map(
    (item) => item.snippet.resourceId.videoId
  );

  if (!videoIds.length) return [];

  const videosRes = await youtube.videos.list({
    part: ['snippet', 'liveStreamingDetails'],
    id: videoIds,
  });

  return videosRes.data.items.map((v) => ({
    id: v.id,
    title: v.snippet.title,
    publishedAt: v.snippet.publishedAt,
    description: v.snippet.description,
    isLive: !!v.liveStreamingDetails,
    url: `https://youtu.be/${v.id}`,
  }));
}

async function main() {
  console.log('🔑 Авторизація...');
  const auth = await getAuthClient();
  const youtube = google.youtube({ version: 'v3', auth });

  const result = [];

  for (const channel of CHANNELS) {
    console.log(`📺 ${channel.name}`);
    try {
      const videos = await getChannelVideos(youtube, channel.id, VIDEOS_PER_CHANNEL);
      result.push({ ...channel, videos });
      console.log(`   ✅ ${videos.length} відео`);
    } catch (err) {
      console.error(`   ❌ ${err.message}`);
      result.push({ ...channel, videos: [], error: err.message });
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // Зберігаємо JSON
  fs.writeFileSync('descriptions.json', JSON.stringify(result, null, 2), 'utf-8');

  // Зберігаємо Markdown
  let md = '# Описи відео українських сімрейсерів\n\n';
  for (const channel of result) {
    md += `## ${channel.name}\n\n`;
    if (channel.error) {
      md += `> ❌ ${channel.error}\n\n---\n\n`;
      continue;
    }
    for (const v of channel.videos) {
      md += `### ${v.title}\n`;
      md += `- ${v.url} | ${v.publishedAt?.slice(0, 10)} | стрім: ${v.isLive ? 'так' : 'ні'}\n\n`;
      md += `**Опис:**\n\`\`\`\n${v.description || '(порожньо)'}\n\`\`\`\n\n`;
    }
    md += '---\n\n';
  }
  fs.writeFileSync('descriptions.md', md, 'utf-8');

  console.log('\n✅ Готово! Збережено descriptions.json і descriptions.md');
  console.log('📋 Скинь descriptions.md сюди — зроблю аналіз');
}

main().catch(console.error);

