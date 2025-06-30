// 📦 SoundPort Backend: Spotify + YouTube Playlist Bridge
const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));



const client_id = process.env.YT_CLIENT_ID;
const client_secret = process.env.YT_CLIENT_SECRET;
const redirect_uri = process.env.YT_REDIRECT_URI || 'http://localhost:3000/oauth2callback';
const scope = 'https://www.googleapis.com/auth/youtube';
let refresh_token = process.env.YT_REFRESH_TOKEN || '';

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
let spotifyToken = null;
let spotifyTokenExpiry = null;

// === AUTH: YouTube OAuth2 Flow ===
app.get('/auth', (req, res) => {
  const url = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${client_id}&` +
    `redirect_uri=${redirect_uri}&` +
    `response_type=code&` +
    `scope=${scope}&` +
    `access_type=offline&` +
    `prompt=consent`;
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  try {
    const response = await axios.post('https://oauth2.googleapis.com/token', null, {
      params: {
        code,
        client_id,
        client_secret,
        redirect_uri,
        grant_type: 'authorization_code'
      }
    });
    refresh_token = response.data.refresh_token;
    console.log('✅ Refresh token obtained. Save this to .env:', refresh_token);
    res.send('✅ Auth complete. You can close this tab.');
  } catch (err) {
    console.error('❌ Auth failed:', err.response?.data || err.message);
    res.send('❌ Failed to authenticate.');
  }
});

async function getAccessToken() {
  const response = await axios.post('https://oauth2.googleapis.com/token', null, {
    params: {
      client_id,
      client_secret,
      refresh_token,
      grant_type: 'refresh_token'
    }
  });
  return response.data.access_token;
}

// === SPOTIFY HELPERS ===
function extractSpotifyTrackId(link) {
  return link?.split('/').pop()?.split('?')[0] || null;
}

function extractSpotifyPlaylistId(link) {
  return link?.split('/').pop()?.split('?')[0] || null;
}

function isSpotifyPlaylist(link) {
  return /spotify\.com\/playlist\//.test(link);
}

async function getSpotifyAccessToken() {
  if (spotifyToken && spotifyTokenExpiry > Date.now()) return spotifyToken;
  const encoded = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${encoded}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  spotifyToken = data.access_token;
  spotifyTokenExpiry = Date.now() + data.expires_in * 1000 - 60000;
  return spotifyToken;
}

async function getSpotifyTrack(trackId) {
  const token = await getSpotifyAccessToken();
  const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const track = await res.json();
  return {
    found: true,
    name: track.name,
    artist: track.artists.map(a => a.name).join(', '),
    album: track.album.name,
    image: track.album.images?.[0]?.url,
    spotifyUrl: track.external_urls.spotify,
    previewUrl: track.preview_url,
    duration: Math.floor(track.duration_ms / 1000)
  };
}

async function getSpotifyPlaylistTracks(playlistId) {
  const token = await getSpotifyAccessToken();
  let offset = 0;
  let allTracks = [];
  while (true) {
    const url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&offset=${offset}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!data.items || !data.items.length) break;
    const tracks = data.items.filter(t => t.track && !t.is_local).map(t => ({
      name: t.track.name,
      artist: t.track.artists?.[0]?.name || 'Unknown'
    }));
    allTracks.push(...tracks);
    if (data.items.length < 100) break;
    offset += 100;
  }
  return allTracks;
}

async function searchYouTubeFromSpotifyTrack(trackName, artistName) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const query = `${trackName} ${artistName}`;
  const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}&key=${apiKey}`;
  const res = await fetch(ytUrl);
  const data = await res.json();
  const item = data.items?.[0];
  if (!item) return { found: false };
  return {
    found: true,
    title: item.snippet.title,
    videoId: item.id.videoId,
    youtubeUrl: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    youtubeMusicUrl: `https://music.youtube.com/watch?v=${item.id.videoId}`
  };
}

// === API ROUTE ===
app.post('/api/getTitle', async (req, res) => {
  const { link } = req.body;
  if (!link) return res.status(400).json({ error: 'Missing media link' });

  try {
    if (isSpotifyPlaylist(link)) {
      const playlistId = extractSpotifyPlaylistId(link);
      const tracks = await getSpotifyPlaylistTracks(playlistId);
      return res.json({ message: 'Playlist fetched', count: tracks.length, tracks });
    }

    if (link.includes('/track/')) {
      const trackId = extractSpotifyTrackId(link);
      const track = await getSpotifyTrack(trackId);
      const youtube = await searchYouTubeFromSpotifyTrack(track.name, track.artist);
      return res.json({ spotify: track, youtube, youtubeMusicUrl: youtube.youtubeMusicUrl });
    }

    if (link.includes('youtube.com') || link.includes('youtu.be')) {
      const videoId = link.includes('watch?v=') ? link.split('v=')[1].split('&')[0] : link.split('/').pop();
      const apiKey = process.env.YOUTUBE_API_KEY;
      const ytUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoId}&key=${apiKey}`;
      const ytRes = await fetch(ytUrl);
      const ytData = await ytRes.json();
      const video = ytData.items?.[0];
      if (!video) return res.status(404).json({ error: 'Video not found' });
      const youtube = {
        id: videoId,
        title: video.snippet.title,
        channel: video.snippet.channelTitle,
        thumbnail: video.snippet.thumbnails.medium.url,
        publishedAt: new Date(video.snippet.publishedAt).toLocaleDateString(),
        viewCount: video.statistics.viewCount
      };
      const spotify = await searchSpotifyTrack(video.snippet.title);
      const youtubeMusicUrl = `https://music.youtube.com/watch?v=${videoId}`;
      return res.json({ youtube, spotify, youtubeMusicUrl });
    }

    return res.status(400).json({ error: 'Unsupported link format' });
  } catch (err) {
    console.error('❌ Error in getTitle:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
app.listen(PORT, () => {
  console.log(`Example app listening on port ${PORT}`)
});


// 

