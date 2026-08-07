// ---------------------------------------------------------------------------
// DISCORD MESSAGE BUILDER
// Self-contained module (its own event listeners, own customId namespace
// `mb_*`) - registered from index.js via registerMessageBuilder(client).
// Keeps a permanent "Start Message" button present in MESSAGE_BUILDER_CHANNEL_ID
// (re-posted on startup and immediately re-posted if it's ever deleted).
// Clicking it walks a leader through Event -> Angle -> a short sequence of
// inputs (Day/Time/groups/etc, all funneled through a generic step-runner)
// and DMs them the finished, ready-to-paste message.
//
// Everything here is scoped to MESSAGE_BUILDER_CHANNEL_ID - interactions
// from any other channel are ignored.
// ---------------------------------------------------------------------------
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const MESSAGE_BUILDER_CHANNEL_ID = process.env.MESSAGE_BUILDER_CHANNEL_ID;

// Concurrent builds allowed - keyed by an incrementing counter, not per-user,
// same pattern as pendingVipActions/pendingPotwSubmissions in index.js.
const pendingBuilds = new Map(); // key -> { key, userId, eventKey, angleKey, steps, stepIndex, collected }
let buildCounter = 0;

// The "Start Message" button is kept permanently present in the channel
// rather than typed on demand - re-posted on startup (if missing) and
// immediately re-posted if it's ever deleted (single or bulk delete).
let stickyMessageId = null;

function buildStartButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mb_start').setLabel('Start Message').setStyle(ButtonStyle.Primary)
  );
}

async function ensureStickyButton(client) {
  if (!MESSAGE_BUILDER_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(MESSAGE_BUILDER_CHANNEL_ID);
    if (!channel) return;

    if (stickyMessageId) {
      const stillThere = await channel.messages.fetch(stickyMessageId).catch(() => null);
      if (stillThere) return;
      stickyMessageId = null;
    } else {
      // Covers a restart: reuse an existing button rather than posting a duplicate.
      const recent = await channel.messages.fetch({ limit: 50 });
      const existing = recent.find(m => m.author.id === client.user.id && m.components?.[0]?.components?.[0]?.customId === 'mb_start');
      if (existing) {
        stickyMessageId = existing.id;
        return;
      }
    }

    const sent = await channel.send({ content: 'Click below to build a ready-to-paste message for an event.', components: [buildStartButtonRow()] });
    stickyMessageId = sent.id;
  } catch (err) {
    console.error('Message Builder: failed to ensure sticky button:', err.message);
  }
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
// Reuses the bot's established 4-hourly server-time cadence (index.js
// SB_SLOT_HOURS) as the "common server-time slots" list, rather than
// inventing a new one.
const TIME_SLOT_HOURS = [0, 4, 8, 12, 16, 20];

function formatTimeValue(hour) {
  return `${String(hour).padStart(2, '0')}:00 server time`;
}

// ---------------------------------------------------------------------------
// Shared scheduling clause helpers - every template routes through these
// rather than hand-building "at {time} on {day}", so no template can ever
// produce a dangling "at on" or an empty clause.
// ---------------------------------------------------------------------------
function scheduleClause(day, time) {
  if (day && time) return `at ${time} on ${day}`;
  if (time) return `at ${time}`;
  if (day) return `on ${day}`;
  return 'soon';
}

// Rescheduled messages get their own resolver (not scheduleClause + a
// prepended "to", which reads awkwardly as "moved to at 16:00...") so every
// combination still reads as a natural "has been moved {clause}." sentence.
function rescheduleClause(day, time) {
  if (!day && !time) return "to a new time, we'll confirm soon";
  if (day && time) return `to ${time} on ${day}`;
  if (time) return `to ${time}`;
  return `to ${day}`;
}

// Generic reusable template for the Cancelled/Rescheduled angle that most
// events share - takes the event/group's display name as a parameter rather
// than being duplicated per event.
function cancelledRescheduledTemplate(subject, c) {
  if (c.decision === 'cancelled') {
    const reasonPart = c.reason ? `${c.reason} ` : '';
    return `Hey everyone, ${subject} has been cancelled this time. ${reasonPart}Thanks so much for your understanding, we'll sort things out for next time!`;
  }
  return `Small change, ${subject} has been moved ${rescheduleClause(c.day, c.time)}. Sorry for any mix-up, and we look forward to seeing you there!`;
}

// ---------------------------------------------------------------------------
// Step renderers - one per reusable step "type". Day/Time always include a
// Skip option since both are optional everywhere per spec. modalNote steps
// aren't rendered here (a modal can only be shown as the direct response to
// the interaction that triggered it) - handled specially in the runner.
// ---------------------------------------------------------------------------
function buildDaySelect(key) {
  const options = DAY_NAMES.map(d => ({ label: d, value: d }));
  options.push({ label: 'Skip (no day)', value: 'skip' });
  const menu = new StringSelectMenuBuilder().setCustomId(`mb_step_${key}`).setPlaceholder('Pick a day (optional)').addOptions(options);
  return { content: 'Pick a day (optional):', embeds: [], components: [new ActionRowBuilder().addComponents(menu)] };
}

function buildTimeSelect(key) {
  const options = TIME_SLOT_HOURS.map(h => ({ label: formatTimeValue(h), value: String(h) }));
  options.push({ label: 'Other (enter a custom time)', value: 'other' });
  options.push({ label: 'Skip (no time)', value: 'skip' });
  const menu = new StringSelectMenuBuilder().setCustomId(`mb_step_${key}`).setPlaceholder('Pick a time (optional)').addOptions(options);
  return { content: 'Pick a time (optional):', embeds: [], components: [new ActionRowBuilder().addComponents(menu)] };
}

function buildGroupSingleSelect(key) {
  const menu = new StringSelectMenuBuilder().setCustomId(`mb_step_${key}`).setPlaceholder('Pick a group').addOptions(
    { label: 'Team A', value: 'A' },
    { label: 'Team B', value: 'B' }
  );
  return { content: 'Which group is this for?', embeds: [], components: [new ActionRowBuilder().addComponents(menu)] };
}

// Buttons rather than a multi-select dropdown - "pick one or both from two
// checkboxes" wasn't a discoverable way to select both, an explicit "Both
// Teams" button is unambiguous.
function buildGroupMultiChoiceButtons(key) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mb_step_${key}_A`).setLabel('Team A').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mb_step_${key}_B`).setLabel('Team B').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mb_step_${key}_both`).setLabel('Both Teams').setStyle(ButtonStyle.Primary)
  );
  return { content: 'Which group(s) are registering?', embeds: [], components: [row] };
}

function buildCancelRescheduleButtons(key) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mb_step_${key}_cancelled`).setLabel('Cancelled').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`mb_step_${key}_rescheduled`).setLabel('Rescheduled').setStyle(ButtonStyle.Primary)
  );
  return { content: 'Is this cancelled or rescheduled?', embeds: [], components: [row] };
}

function buildTeleportToggleButtons(key) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mb_step_${key}_yes`).setLabel('Add teleport reminder').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mb_step_${key}_no`).setLabel('Skip').setStyle(ButtonStyle.Secondary)
  );
  return { content: 'Include a reminder to teleport into position first?', embeds: [], components: [row] };
}

// Every step shows a header naming the event, the angle, and - when a step
// carries a `subject` (e.g. Elixir Scramble's per-group day/time pairs once
// "Both Teams" is picked) - which one it's currently collecting for. Without
// this, a leader mid-flow has no way to tell which of two identical-looking
// "Pick a day" prompts they're answering.
function stepContextLabel(pending, step) {
  const ev = EVENTS[pending.eventKey];
  const angle = ev.angles[pending.angleKey];
  let label = `${ev.label} — ${angle.label}`;
  const subject = (step && step.subject) || pending.groupSubject;
  if (subject) label += ` (${subject})`;
  return label;
}

function buildNoteModal(pending, step) {
  const key = pending.key;
  const title = `${stepContextLabel(pending, step)}`.slice(0, 45); // Discord modal titles cap at 45 chars
  const modal = new ModalBuilder().setCustomId(`mb_notemodal_${key}`).setTitle(title);
  const input = new TextInputBuilder()
    .setCustomId('mb_noteinput')
    .setLabel(step.label || 'Note (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function buildFreeTimeModal(pending, step) {
  const key = pending.key;
  const title = `${stepContextLabel(pending, step)}`.slice(0, 45);
  const modal = new ModalBuilder().setCustomId(`mb_othertimemodal_${key}`).setTitle(title);
  const input = new TextInputBuilder()
    .setCustomId('mb_timeinput')
    .setLabel('Time (e.g. "14:30 server time")')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function renderStepComponents(pending) {
  const step = pending.steps[pending.stepIndex];
  const key = pending.key;
  let result;
  switch (step.type) {
    case 'day': result = buildDaySelect(key); break;
    case 'time': result = buildTimeSelect(key); break;
    case 'groupSingle': result = buildGroupSingleSelect(key); break;
    case 'groupMulti': result = buildGroupMultiChoiceButtons(key); break;
    case 'toggleCancelReschedule': result = buildCancelRescheduleButtons(key); break;
    case 'teleportToggle': result = buildTeleportToggleButtons(key); break;
    default: return null; // modalNote is shown via showModal, not rendered as an update
  }
  result.content = `**${stepContextLabel(pending, step)}**\n${result.content}`;
  return result;
}

// ---------------------------------------------------------------------------
// EVENTS config - the 10 events / ~25 angles, using the exact wording from
// the approved spec. Each angle's `steps` list drives the generic runner;
// `template(collected)` builds the final text once all steps resolve.
// ---------------------------------------------------------------------------
const EVENTS = {
  elixir_scramble: {
    label: 'Elixir Scramble',
    angles: {
      registration: {
        label: 'Registration open',
        steps: [{ type: 'groupMulti', key: 'groups' }],
        template: (c) => {
          if (c.groups.length === 1) {
            const g = c.groups[0];
            const schedule = scheduleClause(c[`day_${g}`], c[`time_${g}`]);
            return `Hey WTF fam! Elixir Scramble Team ${g} registration is now open, jump in! Team ${g} kicks off ${schedule}, so grab your spot early and get your squad ready. Looking forward to seeing you all out there!`;
          }
          const schedA = scheduleClause(c.day_A, c.time_A);
          const schedB = scheduleClause(c.day_B, c.time_B);
          return `Hey WTF fam! Registration for Elixir Scramble is now open for both Team A and Team B, let's go! Team A kicks off ${schedA}, and Team B follows ${schedB}. Grab your spot early and get your squad ready, looking forward to seeing you all out there!`;
        },
      },
      reminder: {
        label: 'Reminder',
        steps: [{ type: 'groupSingle', key: 'group' }, { type: 'day', key: 'day' }, { type: 'time', key: 'time' }],
        template: (c) => `Just a friendly heads up, Elixir Scramble Team ${c.group} kicks off ${scheduleClause(c.day, c.time)}. Get your squad prepped and ready to go, we'd love to have you there. Don't miss it!`,
      },
      cancelledRescheduled: {
        label: 'Cancelled / Rescheduled',
        steps: [{ type: 'groupSingle', key: 'group' }, { type: 'toggleCancelReschedule' }],
        template: (c) => cancelledRescheduledTemplate(`Elixir Scramble Team ${c.group}`, c),
      },
    },
  },

  pandemic_personal: {
    label: 'Pandemic Experience (Personal Challenge)',
    angles: {
      warning: {
        label: 'Warning / Advisory',
        steps: [{ type: 'modalNote', key: 'note', label: 'Extra note (optional)', modalTitle: 'Personal Pandemic warning' }],
        template: (c) => {
          const base = "Friendly reminder for the Personal Pandemic Challenge, please only pick the level one tier above your required might. Going higher can cost you troops, and we'd really hate to see that happen to any of you. Play it safe out there and enjoy the challenge!";
          return c.note ? `${base} ${c.note}` : base;
        },
      },
    },
  },

  pandemic_alliance: {
    label: 'Pandemic Experience (Alliance Challenge)',
    angles: {
      launch: {
        label: 'Launch announcement',
        steps: [{ type: 'day', key: 'day' }, { type: 'time', key: 'time' }],
        template: (c) => `Hey WTF! The Alliance Pandemic Challenge is launching ${scheduleClause(c.day, c.time)}, let's bring our A-game together and show what we can do as a team. Looking forward to seeing you all there!`,
      },
      reminder: {
        label: 'Reminder',
        steps: [{ type: 'day', key: 'day' }, { type: 'time', key: 'time' }],
        template: (c) => `Quick reminder, the Alliance Pandemic Challenge launches ${scheduleClause(c.day, c.time)}. Get your gear and squads ready, we'd love a big turnout. See you soon!`,
      },
      cancelledRescheduled: {
        label: 'Cancelled / Rescheduled',
        steps: [{ type: 'toggleCancelReschedule' }],
        template: (c) => cancelledRescheduledTemplate('the Alliance Pandemic Challenge', c),
      },
    },
  },

  canyon_conquest: {
    label: 'Canyon Conquest',
    angles: {
      registration: {
        label: 'Registration open',
        steps: [{ type: 'day', key: 'day' }, { type: 'time', key: 'time' }],
        template: (c) => `Hey WTF! Canyon Conquest sign-ups are open, pick any of the 3 lanes and pop in 1 weak soldier for now, this helps us land an easier matchup for everyone. Sign-ups close ${scheduleClause(c.day, c.time)}, so don't wait too long to grab your spot!`,
      },
      reminder: {
        label: 'Reminder (sign-up)',
        steps: [{ type: 'day', key: 'day' }, { type: 'time', key: 'time' }],
        template: (c) => `Just a friendly nudge, Canyon Conquest sign-ups close ${scheduleClause(c.day, c.time)}. Don't forget, 1 weak soldier and pick your lane! We'd love to see as many of you registered as possible.`,
      },
      squadSwapNotice: {
        label: 'Squad swap notice',
        steps: [{ type: 'day', key: 'day' }, { type: 'time', key: 'time' }],
        template: (c) => `Good news, matching is done for Canyon Conquest! Time to swap that weak soldier out for your strong squad before we kick off ${scheduleClause(c.day, c.time)}. Get ready, this is where the real fun begins!`,
      },
      squadSwapReminder: {
        label: 'Squad swap reminder',
        steps: [{ type: 'day', key: 'day' }, { type: 'time', key: 'time' }],
        template: (c) => `Reminder, Canyon Conquest starts ${scheduleClause(c.day, c.time)}. Double check you've swapped in your strong squad, we want everyone at full strength. Looking forward to a great battle together!`,
      },
      cancelledRescheduled: {
        label: 'Cancelled / Rescheduled',
        steps: [{ type: 'toggleCancelReschedule' }],
        template: (c) => cancelledRescheduledTemplate('Canyon Conquest', c),
      },
    },
  },

  undead_siege: {
    label: 'Undead Siege',
    angles: {
      attendanceCall: {
        label: 'Attendance call',
        steps: [{ type: 'day', key: 'day' }, { type: 'time', key: 'time' }],
        template: (c) => `Hey WTF! Undead Siege is happening ${scheduleClause(c.day, c.time)}. Let's look out for our neighbours, please send your 2nd/3rd squads to help defend them. Also remember to turn on the defence in your wall before it starts, and turn it back off once the event ends. We really appreciate everyone who can lend a hand!`,
      },
      reminder: {
        label: 'Reminder',
        steps: [{ type: 'day', key: 'day' }, { type: 'time', key: 'time' }],
        template: (c) => `Reminder, Undead Siege kicks off ${scheduleClause(c.day, c.time)}. Get your 2nd/3rd squads ready, our neighbours are counting on us. Don't forget to turn on your wall defence before it starts, and remove it again once the event is over. Thanks so much for showing up for the team!`,
      },
      cancelledRescheduled: {
        label: 'Cancelled / Rescheduled',
        steps: [{ type: 'toggleCancelReschedule' }],
        template: (c) => cancelledRescheduledTemplate('Undead Siege', c),
      },
    },
  },

  hunt_battle: {
    label: 'Hunt Battle',
    angles: {
      attendanceCall: {
        label: 'Attendance call',
        steps: [{ type: 'day', key: 'day' }, { type: 'time', key: 'time' }, { type: 'modalNote', key: 'difficulty', label: 'Difficulty (optional, e.g. Hard, Nightmare)', modalTitle: 'Hunt Battle' }],
        template: (c) => {
          if (c.difficulty) {
            return `Hey WTF, Hunt Battle kicks off ${scheduleClause(c.day, c.time)}. We'll be running ${c.difficulty}, bring your squads and get ready to clear waves together. Looking forward to seeing everyone out there!`;
          }
          return `Hey WTF, Hunt Battle kicks off ${scheduleClause(c.day, c.time)}. Bring your squads and get ready to clear waves together. Looking forward to seeing everyone out there!`;
        },
      },
      reminder: {
        label: 'Reminder',
        steps: [{ type: 'day', key: 'day' }, { type: 'time', key: 'time' }],
        template: (c) => `Reminder, Hunt Battle starts ${scheduleClause(c.day, c.time)}. Get your squads positioned early so we can hit the ground running. See you there!`,
      },
      cancelledRescheduled: {
        label: 'Cancelled / Rescheduled',
        steps: [{ type: 'toggleCancelReschedule' }],
        template: (c) => cancelledRescheduledTemplate('Hunt Battle', c),
      },
    },
  },

  alliance_expedition: {
    label: 'Alliance Expedition',
    angles: {
      dailyReminder: {
        label: 'Daily reminder',
        steps: [{ type: 'modalNote', key: 'tier', label: 'Current camp tier (optional)', modalTitle: 'Alliance Expedition' }],
        template: (c) => `Hey WTF, don't forget your 3 Alliance Expedition attacks today! Save them for ${c.tier ? `Camp ${c.tier}` : 'our highest unlocked camp'} to make the most of them, every hit helps the whole alliance push further. Thanks for pitching in!`,
      },
    },
  },

  kingdom_clash: {
    label: 'Kingdom Clash',
    angles: {
      kickoff: {
        label: 'Kickoff announcement',
        steps: [{ type: 'day', key: 'day' }, { type: 'time', key: 'time' }],
        template: (c) => `Hey WTF, Kingdom Clash starts ${scheduleClause(c.day, c.time)}! This is server-wide, our whole kingdom is up against a rival server for a week, and every alliance's points count. Here's how we score: winning Alliance Duel, Alliance Duel MVP, Demon King Blight attacks, Demon King Blight personal damage, hitting the enemy server's Caravans, coming #1 in Survival Battle, and winning Elixir Scramble. Get involved wherever you can this week, every bit helps our kingdom come out on top!`,
      },
      dailyReminder: {
        label: 'Daily / ongoing reminder',
        steps: [{ type: 'modalNote', key: 'focus', label: "Today's focus (optional)", modalTitle: 'Kingdom Clash reminder' }],
        template: (c) => `Reminder, Kingdom Clash is live! ${c.focus ? `Today's focus: ${c.focus}. ` : ''}Keep stacking points: Alliance Duel wins, Demon King Blight damage, hitting enemy Caravans, Survival Battle #1, and Elixir Scramble wins all count toward our kingdom's total. Keep it up, every contribution counts and we appreciate you all!`,
      },
    },
  },

  kingdom_war: {
    label: 'Kingdom War (Royal City Scramble)',
    angles: {
      rallyCall: {
        label: 'Rally call',
        steps: [{ type: 'day', key: 'day' }, { type: 'time', key: 'time' }, { type: 'teleportToggle' }],
        template: (c) => {
          let msg = `Hey WTF, Kingdom War is on! We're attacking as one, everyone rally on the Royal City ${scheduleClause(c.day, c.time)}. Don't split off to hit bases, we're going straight for the center together. Looking forward to a strong showing from all of you!`;
          if (c.teleportReminder) msg += " Make sure you're teleported into position before the rally time!";
          return msg;
        },
      },
      reminder: {
        label: 'Reminder',
        steps: [{ type: 'day', key: 'day' }, { type: 'time', key: 'time' }, { type: 'teleportToggle' }],
        template: (c) => {
          let msg = `Reminder, Kingdom War's Royal City rally starts ${scheduleClause(c.day, c.time)}. Get your marches ready, we want everyone in position together. Thanks for being part of the push!`;
          if (c.teleportReminder) msg += " Make sure you're teleported into position before the rally time!";
          return msg;
        },
      },
      cancelledRescheduled: {
        label: 'Cancelled / Rescheduled',
        steps: [{ type: 'toggleCancelReschedule' }],
        template: (c) => cancelledRescheduledTemplate('Kingdom War', c),
      },
    },
  },

  crystal_cluster_valley: {
    label: 'Crystal Cluster Valley',
    angles: {
      dailyNotice: {
        label: 'Daily notice',
        steps: [],
        // TODO: replace with the 4 real daily server-time slots once confirmed in-game.
        template: () => "Hey WTF, Crystal Cluster Valley is running today! Sessions are at Slot 1 (TBD), Slot 2 (TBD), Slot 3 (TBD), and Slot 4 (TBD), jump into whichever works for you. It's a solo event with great rewards up for grabs, so make the most of it!",
      },
    },
  },

  demon_king: {
    label: 'Demon King',
    angles: {
      attackCall: {
        label: 'Attack call',
        steps: [{ type: 'day', key: 'day' }],
        template: (c) => {
          if (c.day) return `Hey WTF, Demon King is up on ${c.day}! Get your 10 attacks in, great rewards, and it also helps our KvK points. Thanks for taking the time to join in!`;
          return 'Hey WTF, Demon King is up! Get your 10 attacks in, great rewards, and it also helps our KvK points. Thanks for taking the time to join in!';
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Entry-point builders (event/angle pickers) + the generic step-runner.
// ---------------------------------------------------------------------------
function buildEventSelect(key) {
  const options = Object.entries(EVENTS).map(([evKey, ev]) => ({ label: ev.label, value: evKey }));
  const menu = new StringSelectMenuBuilder().setCustomId(`mb_event_${key}`).setPlaceholder('Which event?').addOptions(options);
  return { content: 'Which event is this message for?', embeds: [], components: [new ActionRowBuilder().addComponents(menu)] };
}

function buildAngleSelect(key, eventKey) {
  const ev = EVENTS[eventKey];
  const options = Object.entries(ev.angles).map(([angleKey, angle]) => ({ label: angle.label, value: angleKey }));
  const menu = new StringSelectMenuBuilder().setCustomId(`mb_angle_${key}`).setPlaceholder('Which angle?').addOptions(options);
  return { content: `${ev.label} - what kind of message?`, embeds: [], components: [new ActionRowBuilder().addComponents(menu)] };
}

function beginAngle(pending, eventKey, angleKey) {
  pending.eventKey = eventKey;
  pending.angleKey = angleKey;
  const angle = EVENTS[eventKey].angles[angleKey];
  pending.steps = angle.steps.map(s => ({ ...s })); // per-build copy - steps get spliced dynamically
  pending.stepIndex = 0;
  pending.collected = {};
  pending.groupSubject = null;
}

async function renderCurrentStepOrDeliver(interaction, key) {
  const pending = pendingBuilds.get(key);
  if (!pending) {
    await interaction.update({ content: 'This build has expired - please click Start Message again.', embeds: [], components: [] }).catch(() => {});
    return;
  }
  if (pending.stepIndex >= pending.steps.length) {
    await deliverBuiltMessage(interaction, pending);
    return;
  }
  const step = pending.steps[pending.stepIndex];
  if (step.type === 'modalNote') {
    await interaction.showModal(buildNoteModal(pending, step));
    return;
  }
  await interaction.update(renderStepComponents(pending));
}

async function deliverBuiltMessage(interaction, pending) {
  const angle = EVENTS[pending.eventKey].angles[pending.angleKey];
  const text = angle.template(pending.collected);
  const codeBlock = '```\n' + text + '\n```';

  await interaction.deferUpdate();
  try {
    const user = await interaction.client.users.fetch(pending.userId);
    await user.send(codeBlock);
    await interaction.editReply({ content: 'Sent to your DMs! Check there for the finished message.', embeds: [], components: [] });
  } catch (err) {
    console.error('Message Builder: DM delivery failed, falling back to ephemeral:', err.message);
    await interaction.editReply({ content: `Couldn't DM you (your DMs might be closed) - here's your message:\n${codeBlock}`, embeds: [], components: [] });
  } finally {
    pendingBuilds.delete(pending.key);
  }
}

// ---------------------------------------------------------------------------
// registerMessageBuilder(client) - self-contained listeners.
// ---------------------------------------------------------------------------
function registerMessageBuilderImpl(client) {
  client.once('ready', () => ensureStickyButton(client));

  client.on('messageDelete', async (message) => {
    if (!MESSAGE_BUILDER_CHANNEL_ID || message.channelId !== MESSAGE_BUILDER_CHANNEL_ID) return;
    if (message.id !== stickyMessageId) return;
    stickyMessageId = null;
    await ensureStickyButton(client);
  });

  client.on('messageDeleteBulk', async (messages) => {
    if (!MESSAGE_BUILDER_CHANNEL_ID) return;
    const first = messages.first();
    if (!first || first.channelId !== MESSAGE_BUILDER_CHANNEL_ID) return;
    if (!messages.has(stickyMessageId)) return;
    stickyMessageId = null;
    await ensureStickyButton(client);
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
    if (!MESSAGE_BUILDER_CHANNEL_ID || interaction.channelId !== MESSAGE_BUILDER_CHANNEL_ID) return;
    const id = interaction.customId;
    if (!id.startsWith('mb_')) return; // not ours - let index.js's listener handle it

    try {
      if (id === 'mb_start') {
        const key = `${++buildCounter}`;
        pendingBuilds.set(key, { key, userId: interaction.user.id, eventKey: null, angleKey: null, steps: [], stepIndex: 0, collected: {} });
        await interaction.reply({ ...buildEventSelect(key), ephemeral: true });
        return;
      }

      const eventMatch = id.match(/^mb_event_(\d+)$/);
      if (eventMatch) {
        const key = eventMatch[1];
        const pending = pendingBuilds.get(key);
        if (!pending) {
          await interaction.update({ content: 'This build has expired - please click Start Message again.', embeds: [], components: [] });
          return;
        }
        const eventKey = interaction.values[0];
        const ev = EVENTS[eventKey];
        const angleKeys = Object.keys(ev.angles);
        if (angleKeys.length === 1) {
          beginAngle(pending, eventKey, angleKeys[0]);
          await renderCurrentStepOrDeliver(interaction, key);
        } else {
          pending.eventKey = eventKey;
          await interaction.update(buildAngleSelect(key, eventKey));
        }
        return;
      }

      const angleMatch = id.match(/^mb_angle_(\d+)$/);
      if (angleMatch) {
        const key = angleMatch[1];
        const pending = pendingBuilds.get(key);
        if (!pending) {
          await interaction.update({ content: 'This build has expired - please click Start Message again.', embeds: [], components: [] });
          return;
        }
        beginAngle(pending, pending.eventKey, interaction.values[0]);
        await renderCurrentStepOrDeliver(interaction, key);
        return;
      }

      // Select-menu steps: day / time / groupSingle share one customId shape.
      const stepSelectMatch = id.match(/^mb_step_(\d+)$/);
      if (stepSelectMatch) {
        const key = stepSelectMatch[1];
        const pending = pendingBuilds.get(key);
        if (!pending) {
          await interaction.update({ content: 'This build has expired - please click Start Message again.', embeds: [], components: [] });
          return;
        }
        const step = pending.steps[pending.stepIndex];

        if (step.type === 'day') {
          const v = interaction.values[0];
          pending.collected[step.key] = v === 'skip' ? null : v;
          pending.stepIndex++;
          await renderCurrentStepOrDeliver(interaction, key);
          return;
        }

        if (step.type === 'time') {
          const v = interaction.values[0];
          if (v === 'other') {
            await interaction.showModal(buildFreeTimeModal(pending, step));
            return;
          }
          pending.collected[step.key] = v === 'skip' ? null : formatTimeValue(Number(v));
          pending.stepIndex++;
          await renderCurrentStepOrDeliver(interaction, key);
          return;
        }

        if (step.type === 'groupSingle') {
          pending.collected[step.key] = interaction.values[0];
          // Applies to the whole rest of this flow (e.g. the toggle and
          // reason/reschedule steps that follow) - stepContextLabel falls
          // back to this whenever a step doesn't set its own `subject`.
          pending.groupSubject = `Team ${interaction.values[0]}`;
          pending.stepIndex++;
          await renderCurrentStepOrDeliver(interaction, key);
          return;
        }

        return;
      }

      // Button-driven "choice" steps: the choice is carried in the customId
      // suffix (buttons don't have a separate values array like selects do).
      const stepButtonMatch = id.match(/^mb_step_(\d+)_(.+)$/);
      if (stepButtonMatch) {
        const [, key, choice] = stepButtonMatch;
        const pending = pendingBuilds.get(key);
        if (!pending) {
          await interaction.update({ content: 'This build has expired - please click Start Message again.', embeds: [], components: [] });
          return;
        }
        const step = pending.steps[pending.stepIndex];

        if (step.type === 'groupMulti') {
          const groups = choice === 'both' ? ['A', 'B'] : [choice];
          pending.collected[step.key] = groups;
          const newSteps = [];
          for (const g of groups) {
            newSteps.push(
              { type: 'day', key: `day_${g}`, subject: `Team ${g}` },
              { type: 'time', key: `time_${g}`, subject: `Team ${g}` }
            );
          }
          pending.steps.splice(pending.stepIndex + 1, 0, ...newSteps);
          pending.stepIndex++;
          await renderCurrentStepOrDeliver(interaction, key);
          return;
        }

        if (step.type === 'toggleCancelReschedule') {
          pending.collected.decision = choice;
          if (choice === 'cancelled') {
            pending.steps.splice(pending.stepIndex + 1, 0, { type: 'modalNote', key: 'reason', label: 'Reason (optional)', modalTitle: 'Cancellation reason' });
          } else {
            pending.steps.splice(pending.stepIndex + 1, 0, { type: 'day', key: 'day' }, { type: 'time', key: 'time' });
          }
          pending.stepIndex++;
          await renderCurrentStepOrDeliver(interaction, key);
          return;
        }

        if (step.type === 'teleportToggle') {
          pending.collected.teleportReminder = choice === 'yes';
          pending.stepIndex++;
          await renderCurrentStepOrDeliver(interaction, key);
          return;
        }

        return;
      }

      if (interaction.isModalSubmit()) {
        const noteMatch = id.match(/^mb_notemodal_(\d+)$/);
        if (noteMatch) {
          const key = noteMatch[1];
          const pending = pendingBuilds.get(key);
          if (!pending) {
            await interaction.reply({ content: 'This build has expired - please click Start Message again.', ephemeral: true });
            return;
          }
          const step = pending.steps[pending.stepIndex];
          const value = interaction.fields.getTextInputValue('mb_noteinput').trim();
          pending.collected[step.key] = value || null;
          pending.stepIndex++;
          await renderCurrentStepOrDeliver(interaction, key);
          return;
        }

        const timeMatch = id.match(/^mb_othertimemodal_(\d+)$/);
        if (timeMatch) {
          const key = timeMatch[1];
          const pending = pendingBuilds.get(key);
          if (!pending) {
            await interaction.reply({ content: 'This build has expired - please click Start Message again.', ephemeral: true });
            return;
          }
          const step = pending.steps[pending.stepIndex];
          const value = interaction.fields.getTextInputValue('mb_timeinput').trim();
          pending.collected[step.key] = value || null;
          pending.stepIndex++;
          await renderCurrentStepOrDeliver(interaction, key);
          return;
        }
      }
    } catch (err) {
      console.error('Message Builder error:', err.message);
      const errorReply = { content: 'Something went wrong - please click Start Message again.', embeds: [], components: [] };
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(errorReply);
        } else {
          await interaction.reply({ ...errorReply, ephemeral: true });
        }
      } catch (_) { /* interaction likely already gone - nothing more we can do */ }
    }
  });
}

module.exports = { registerMessageBuilder: registerMessageBuilderImpl };
