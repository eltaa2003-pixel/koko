# wa-bot

Lightweight WhatsApp bot on [Baileys](https://github.com/WhiskeySockets/Baileys) v7, with a plugin
system that works like Miku's did — drop a file in `plugins/`, it's a command.

## Run it

```
npm install
npm start
```

A QR code prints in your terminal. Scan it from WhatsApp on your phone:
**Linked devices → Link a device**. Once connected, your session is saved in
`auth_info/` so you won't need to re-scan on restart (delete that folder to
force a fresh login).

Try it: send `.ping` or `.help` to the linked number from any chat.

## Add a plugin

Drop a file in `plugins/`, default-export an object like this:

```js
export default {
  name: 'echo',
  aliases: ['say'],
  description: 'Repeats what you said',
  cooldown: 2, // seconds, optional — defaults to 2

  async execute(ctx) {
    await ctx.reply(ctx.args.join(' ') || 'say something first');
  }
};
```

That's it — no registration step, the loader picks it up on next start.

### What `ctx` gives you

| field | what it is |
|---|---|
| `ctx.sock` | the Baileys socket — full API access (`sock.sendMessage`, `sock.groupMetadata`, etc.) |
| `ctx.reply(text)` | shortcut to reply in the current chat, quoting the trigger message |
| `ctx.msg` | the raw message object |
| `ctx.chatId` | the chat JID |
| `ctx.sender` | the sender's JID (participant JID in groups, chat JID in DMs) |
| `ctx.isGroup` | boolean |
| `ctx.args` | the command text split on whitespace, prefix and command name stripped |
| `ctx.text` | full raw message text |
| `ctx.store` | `ctx.store.namespace('yourPluginName')` → a private `Map` for any state you need to keep between messages |
| `ctx.commands` | the full loaded command registry, if you need to inspect other plugins (see `help.js`) |

Command prefix is `.` by default — change it in `config.js`.

## Notes

- **Deploying somewhere with an ephemeral filesystem (e.g. Render's free tier):**
  `auth_info/` gets wiped on every redeploy, which means re-scanning the QR
  every time. Worth solving with a persistent disk or by syncing that folder
  to external storage before porting the tournament plugins over — didn't
  build that here since the goal was just getting a lean bot running first.
- Logging is `pino`, level `warn` by default. Run with `LOG_LEVEL=debug npm start`
  if you need to see what's happening on the wire.
