# Last Asylum Plague - Alliance Bot (v1: SB + AD reminders)

Posts automatic reminders to a Discord channel:
- **SB Survival Battle**: every 4 hours (03:00, 07:00, 11:00, 15:00, 19:00, 23:00 GMT),
  announcing the current activity and how to score points for it.
- **Alliance Duel (AD)**: once daily at 03:00 GMT (Monday-Saturday), announcing the
  day's theme, top scoring actions, and a strategy tip.

All times are GMT, matching the game's server reset (03:00 GMT).

## 1. Create the Discord bot

1. Go to https://discord.com/developers/applications -> New Application.
2. Go to "Bot" -> Add Bot -> copy the **Token** (you'll need this).
3. Under "Privileged Gateway Intents", turn ON **Message Content Intent**. This is
   required for the `!timezone` command to work - without it, the bot can't read
   what people type, and the command will silently do nothing.
4. Go to "OAuth2" -> "URL Generator": check `bot`, then under Bot Permissions check
   `Send Messages`, `Embed Links`, and `Mention @everyone, @here, and All Roles`
   (needed for the automatic reminders). Copy the generated URL and open it to
   invite the bot to your server.

## 2. Get your channel ID

In Discord: User Settings -> Advanced -> turn on **Developer Mode**. Then right-click
the channel you want reminders posted in -> **Copy Channel ID**.

## 3. Configure environment variables

Copy `.env.example` to `.env` and fill in:
- `DISCORD_TOKEN` - the bot token from step 1
- `REMINDER_CHANNEL_ID` - the channel ID from step 2
- `PING_ROLE_ID` - optional, a role ID to @mention on every reminder (leave blank to skip)

## 4. Run locally (to test)

```
npm install
npm start
```

You should see `Logged in as YourBotName#1234` in the console. It will then post
automatically at the next scheduled GMT time - it doesn't post immediately on startup.

## 5. Deploy to Railway (keeps it running 24/7)

1. Push this folder to a GitHub repo (or use Railway's "Deploy from local" CLI).
2. In Railway: New Project -> Deploy from GitHub repo -> select this repo.
3. In the Railway project's **Variables** tab, add `DISCORD_TOKEN`,
   `REMINDER_CHANNEL_ID`, and `PING_ROLE_ID` (same values as your `.env`).
4. Railway will detect `npm start` automatically from `package.json`. Deploy.
5. Check the Railway logs for `Logged in as...` to confirm it's running.

That's it - no server maintenance needed after this, Railway keeps it alive.

## Updating the schedule/scoring data later

All the SB and AD data lives in two objects near the top of `index.js`:
`SB_SCHEDULE` / `SB_SCORING` and `AD_SCHEDULE`. If point values change or you confirm
the remaining TBC values (Enhance Heroes points, full Train Soldiers level list), just
edit those objects directly and redeploy.

## What v1 does NOT do yet

- Doesn't answer general questions on demand - only the `!timezone` command exists.
- Doesn't track roster or point totals.
- Doesn't include the Falcon Quest / Raven Essence / Study Scroll crossovers (marked
  "unconfirmed" in each AD post) - only confirmed crossovers trigger the hold/use logic.

These can be added as v2 whenever you're ready.

## How the SB/AD double-dip reminders work

- The **daily AD post** (03:00 server time) tells members exactly which actions to
  hold back today, and at what server time to use them for double points - e.g.
  "Wait on: Level up Heroes using Antitoxin → use it at 03:00 or 23:00 server time
  when SB switches to Enhance Heroes."
- The **SB post** at each 4-hour slot announces the current activity as normal.
- A **separate crossover alert** fires right after, only when today's AD day has
  something saved for that exact activity+time - a standalone green message so it
  isn't buried inside the regular SB post.
- Actions that don't cross over with SB at all (Covert Ops, Caravans, Hero Shards, etc.)
  are listed separately in the AD post so members know it's safe to use them anytime.

## Server time vs real UTC

All schedule data in `index.js` is written in the game's **server time**, which is
2 hours behind real UTC/GMT (confirmed via a live check: server midnight = 3am
BST in Milton Keynes, and BST = UTC+1, so server = UTC - 2). The
`SERVER_TIME_OFFSET_HOURS` constant near the top of the file handles converting
between the two - cron jobs fire at the correct real-world instant, while all
messages display server-time labels matching what players see in-game. If this
offset is ever wrong, it's a one-line fix (change the constant).

## `!timezone` command

Anyone can type `!timezone CET` (or GMT, EST, PST, IST, AEST, etc.) in any channel
the bot can see, and it replies with today's SB + AD schedule converted to that
zone - no `@everyone` ping, just a normal reply to whoever asked.

Supported zones are listed in the `TIMEZONE_OFFSETS` object near the top of
`index.js`. These are fixed UTC offsets, not DST-aware - members need to pick
whichever currently applies (e.g. CEST instead of CET in summer). Add more zones
there anytime by adding a line like `AEST: 10,`.

**Important:** this command requires the **Message Content Intent** to be enabled
in the Discord Developer Portal (see setup step 3 above) - without it, the bot
can't read the command text at all and will not respond.

## `!cheese` command

Cheese events run **every day** at fixed default server times: **Cheese 1 at
16:00, Cheese 2 at 22:00** (both server time). No one needs to set them daily
- they just run automatically, every day, forever, at those defaults.

Leaders can change either event's daily time with `!cheese 1 07:00` or
`!cheese 2 15:30` (server time, 24-hour format). Once changed, that new time
becomes the permanent daily time - it keeps running at 07:00 every day going
forward, not just once - until a leader changes it again.

Every day, the bot automatically posts (with `@everyone`):
- 1 hour before
- 10 minutes before
- at the start

Every notification includes the rally rule: **only launch 1 rally, don't join
others' rallies** - so offline members still get rewards.

`!timezone` also shows both cheese events' next occurrence, converted to
whatever zone was asked for, alongside the SB/AD schedule.

**Who can change it:** by default, anyone with Administrator permission. To
restrict it to a specific leader role instead, set `LEADER_ROLE_ID` in your
`.env` / Railway variables to that role's ID. Checking status
(`!cheese status`) is open to everyone regardless.

**Resetting to default:** `!cheese 1 reset` (or `cancel`, same thing) sets
Cheese Event 1 back to its default time (16:00). Same for `!cheese 2 reset`
(back to 22:00).

**Checking status:** `!cheese status` shows both events' currently configured
time (marked `default` or `custom`) and a countdown to the next occurrence.

**Limitation:** custom times are stored in memory only - if the bot restarts,
both events revert to their hard-coded defaults (16:00 / 22:00) and any custom
time a leader had set is lost. To change the defaults themselves permanently,
edit `CHEESE_DEFAULTS` near the top of `index.js` and redeploy.

### 15:00 not-set reminder

Once daily at server-time 15:00, the bot checks Cheese Event 1 and 2. An event
is only flagged as "needs setting" if it has genuinely **not run at all today**
AND isn't currently scheduled for later today. If it already ran earlier today
(even though it's since auto-cleared), it's correctly left alone - no reminder
posts unless both, one, or the other genuinely hasn't happened yet.



