const CAT_IMG_API = 'https://api.thecatapi.com/v1/images/search';
const CAT_GIF_API = 'https://cataas.com/cat/gif?json=true';

async function getCatImageUrls(count) {
  const res = await fetch(`${CAT_IMG_API}?limit=${count}`);
  const data = await res.json();
  return data.map(c => c.url);
}

async function getCatGifUrl() {
  const res = await fetch(CAT_GIF_API);
  const data = await res.json();
  return `https://cataas.com${data.url}`;
}

const captions = ['🐾', '😻', '🐱💕', '✨🐈✨'];

export default {
  name: 'cat',
  aliases: ['meow', 'قطة'],
  description: 'Sends 4 cute cat pics + a cat video',
  cooldown: 10,

  async execute(ctx) {
    const [imageUrls, gifUrl] = await Promise.all([
      getCatImageUrls(4),
      getCatGifUrl()
    ]);

    for (let i = 0; i < imageUrls.length; i++) {
      await ctx.sock.sendMessage(
        ctx.chatId,
        { image: { url: imageUrls[i] }, caption: captions[i] || '🐱' },
        { quoted: ctx.msg }
      );
    }

    await ctx.sock.sendMessage(
      ctx.chatId,
      { video: { url: gifUrl }, gifPlayback: true, caption: 'مياو~ 🐾' },
      { quoted: ctx.msg }
    );
  }
};