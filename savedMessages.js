// ---------------------------------------------------------------------------
// SAVED MESSAGES
// Self-contained module (own listeners, own `sm_*` customId namespace) -
// registered from index.js via registerSavedMessages(client). Lets any
// member save a category + title + message text (+ optional image) and
// lets anyone browse by category to retrieve any member's saved messages,
// delivered by DM.
//
// Keeps a permanent "Messages" button present in SAVED_MESSAGES_CHANNEL_ID
// (re-posted on startup and immediately re-posted if it's ever deleted),
// same sticky-button pattern used elsewhere in this bot. Everything here is
// scoped to that one channel - interactions from any other channel are
// ignored.
//
// Security note: edit/update-image actions always operate on
// SAVED_MESSAGES[interaction.user.id] - the acting user's own array - never
// on an id supplied by anyone else, so there's no way to encode someone
// else's message id and edit their content. Retrieval (browsing anyone's
// messages by category) is read-only and explicitly targets a record's
// owner id from the selected value, never the acting user's own array.
// ---------------------------------------------------------------------------
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require('discord.js');

const SAVED_MESSAGES_CHANNEL_ID = process.env.SAVED_MESSAGES_CHANNEL_ID;
const STORAGE_CHANNEL_ID = process.env.VIP_STORAGE_CHANNEL_ID; // reuses the bot's existing storage channel

// userId -> [{ id, category, title, text, imageUrl }]
let SAVED_MESSAGES = {};
let storageMessages = []; // chunked storage message refs, same pattern as birthdayMessages in index.js

// userId -> { messageId, expiresAt } - set right after a message is saved
// (or "Update Image" is clicked) so the next image posted in the channel
// within the window gets attached to that specific saved message.
const pendingImageWait = new Map();
const IMAGE_WAIT_MS = 2 * 60 * 1000;

let stickyMessageId = null;

function buildStartButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sm_start').setLabel('Messages').setStyle(ButtonStyle.Primary)
  );
}

async function ensureStickyButton(client) {
  if (!SAVED_MESSAGES_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(SAVED_MESSAGES_CHANNEL_ID);
    if (!channel) return;

    if (stickyMessageId) {
      const stillThere = await channel.messages.fetch(stickyMessageId).catch(() => null);
      if (stillThere) return;
      stickyMessageId = null;
    } else {
      const recent = await channel.messages.fetch({ limit: 50 });
      const existing = recent.find(m => m.author.id === client.user.id && m.components?.[0]?.components?.[0]?.customId === 'sm_start');
      if (existing) {
        stickyMessageId = existing.id;
        return;
      }
    }

    const sent = await channel.send({ content: 'Click below to save a message or look one up.', components: [buildStartButtonRow()] });
    stickyMessageId = sent.id;
  } catch (err) {
    console.error('Saved Messages: failed to ensure sticky button:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Persistence - same chunked-Discord-message pattern as birthdays/reminders
// in index.js, but chunking a raw JSON string by length rather than joining
// short fixed-format tuples, since titles/message text are free-form.
// ---------------------------------------------------------------------------
async function saveSavedMessagesToDiscord(client) {
  if (!STORAGE_CHANNEL_ID) return;
  const json = JSON.stringify(SAVED_MESSAGES);
  const SAFE_LIMIT = 1900;
  const chunks = [];
  for (let i = 0; i < json.length; i += SAFE_LIMIT) chunks.push(json.slice(i, i + SAFE_LIMIT));
  if (chunks.length === 0) chunks.push('{}');

  try {
    const channel = await client.channels.fetch(STORAGE_CHANNEL_ID);
    if (!channel) return;

    for (let i = 0; i < chunks.length; i++) {
      const content = `SAVEDMSGS${i}:` + chunks[i];
      if (storageMessages[i]) {
        await storageMessages[i].edit(content);
      } else {
        storageMessages[i] = await channel.send(content);
      }
    }
    for (let i = chunks.length; i < storageMessages.length; i++) {
      if (storageMessages[i]) await storageMessages[i].delete().catch(() => {});
    }
    storageMessages.length = chunks.length;
  } catch (err) {
    console.error('Saved Messages: failed to save to Discord:', err.message);
  }
}

async function loadSavedMessagesFromDiscord(client) {
  if (!STORAGE_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(STORAGE_CHANNEL_ID);
    if (!channel) return;

    // Pages back through up to 500 messages, same fix applied to the VIP/
    // birthday loader in index.js, so this doesn't fall prey to the same
    // "fell outside the most-recent-50 window" data loss bug.
    const ownMessages = [];
    let before;
    for (let page = 0; page < 5; page++) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!batch.size) break;
      ownMessages.push(...batch.filter(m => m.author.id === client.user.id).values());
      if (batch.size < 100) break;
      before = batch.last().id;
    }

    const msgs = ownMessages
      .filter(m => /^SAVEDMSGS\d+:/.test(m.content))
      .sort((a, b) => {
        const numA = parseInt(a.content.match(/^SAVEDMSGS(\d+):/)[1], 10);
        const numB = parseInt(b.content.match(/^SAVEDMSGS(\d+):/)[1], 10);
        return numA - numB;
      });

    if (msgs.length) {
      const json = msgs.map(m => m.content.replace(/^SAVEDMSGS\d+:/, '')).join('');
      try {
        SAVED_MESSAGES = JSON.parse(json);
      } catch (err) {
        console.error('Saved Messages: stored data was not valid JSON, starting fresh:', err.message);
        SAVED_MESSAGES = {};
      }
      storageMessages = msgs;
      const total = Object.values(SAVED_MESSAGES).reduce((sum, arr) => sum + arr.length, 0);
      console.log(`Loaded ${total} saved message(s) across ${Object.keys(SAVED_MESSAGES).length} member(s) from Discord storage.`);

      const indices = msgs.map(m => parseInt(m.content.match(/^SAVEDMSGS(\d+):/)[1], 10));
      if (new Set(indices).size !== indices.length) {
        console.log('Found duplicate saved-messages storage messages - consolidating.');
        await saveSavedMessagesToDiscord(client);
      }
    } else {
      await saveSavedMessagesToDiscord(client);
    }
  } catch (err) {
    console.error('Saved Messages: failed to load from Discord:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Category helpers - categories aren't a fixed list, they're derived from
// whatever's actually been saved so far, deduped case-insensitively (first
// casing used wins, so "Recruitment" and "recruitment" don't split into two).
// ---------------------------------------------------------------------------
function getDistinctCategories() {
  const seen = new Map();
  for (const records of Object.values(SAVED_MESSAGES)) {
    for (const r of records) {
      const key = r.category.toLowerCase();
      if (!seen.has(key)) seen.set(key, r.category);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

function getRecordsInCategory(category) {
  const key = category.toLowerCase();
  const results = [];
  for (const [ownerId, records] of Object.entries(SAVED_MESSAGES)) {
    for (const r of records) {
      if (r.category.toLowerCase() === key) results.push({ ...r, ownerId });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
function buildMenuChoiceButtons() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sm_save').setLabel('Save a Message').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('sm_get').setLabel('Get a Message').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sm_mine').setLabel('My Messages').setStyle(ButtonStyle.Secondary)
  );
  return { content: 'What would you like to do?', embeds: [], components: [row] };
}

// One modal, reused for both saving a new message and editing an existing
// one - `prefill` supplies {category, title, text} to pre-fill when editing
// or when a category was already picked via the quick-pick select below.
function buildMessageModal(customId, prefill = {}) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(prefill.title ? 'Edit Message' : 'Save a Message');
  const category = new TextInputBuilder().setCustomId('sm_category').setLabel('Category (existing or new)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50);
  if (prefill.category) category.setValue(prefill.category);
  const title = new TextInputBuilder().setCustomId('sm_title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80);
  if (prefill.title) title.setValue(prefill.title);
  const text = new TextInputBuilder().setCustomId('sm_text').setLabel('Message text').setStyle(TextInputStyle.Paragraph).setRequired(true);
  if (prefill.text) text.setValue(prefill.text);
  modal.addComponents(
    new ActionRowBuilder().addComponents(category),
    new ActionRowBuilder().addComponents(title),
    new ActionRowBuilder().addComponents(text)
  );
  return modal;
}

// Quick-pick shown before the Save modal: choose an existing category (which
// pre-fills the modal's Category field) or "+ New Category" (leaves it blank).
function buildSaveCategorySelect() {
  const categories = getDistinctCategories();
  const options = categories.slice(0, 24).map(c => ({ label: c, value: c }));
  options.push({ label: '+ New Category', value: '__new__' });
  const menu = new StringSelectMenuBuilder().setCustomId('sm_savecat').setPlaceholder('Pick a category or add a new one').addOptions(options);
  return { content: 'Which category is this message for?', embeds: [], components: [new ActionRowBuilder().addComponents(menu)] };
}

function buildGetCategorySelect() {
  const categories = getDistinctCategories();
  const menu = new StringSelectMenuBuilder()
    .setCustomId('sm_getcat')
    .setPlaceholder('Pick a category')
    .addOptions(categories.slice(0, 25).map(c => ({ label: c, value: c })));
  return { content: 'Which category?', embeds: [], components: [new ActionRowBuilder().addComponents(menu)] };
}

function buildOwnTitleSelect(records) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('sm_minetitle')
    .setPlaceholder('Pick a message')
    .addOptions(records.map(r => ({ label: `${r.title} (${r.category})`.slice(0, 100), value: String(r.id) })));
  return { content: 'Which message?', embeds: [], components: [new ActionRowBuilder().addComponents(menu)] };
}

function buildCategoryRecordsSelect(records, memberNames) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('sm_gettitle')
    .setPlaceholder('Pick a message')
    .addOptions(records.map(r => ({
      label: r.title.slice(0, 90),
      description: `by ${memberNames.get(r.ownerId) || 'Unknown'}`.slice(0, 100),
      value: `${r.ownerId}:${r.id}`,
    })));
  return { content: 'Which message?', embeds: [], components: [new ActionRowBuilder().addComponents(menu)] };
}

function buildPreviewEmbed(record) {
  const embed = new EmbedBuilder().setTitle(record.title).setDescription(record.text).setColor(0x38a169).setFooter({ text: record.category });
  if (record.imageUrl) embed.setImage(record.imageUrl);
  return embed;
}

function buildManageButtons(record) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sm_edittext_${record.id}`).setLabel('Edit Message').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sm_updateimage_${record.id}`).setLabel('Update Image').setStyle(ButtonStyle.Secondary)
  );
  return row;
}

async function resolveDisplayName(guild, userId) {
  try {
    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId);
    return member.displayName;
  } catch (_) {
    return null;
  }
}

async function deliverSavedMessage(interaction, record) {
  try {
    const embed = buildPreviewEmbed(record);
    await interaction.user.send({ embeds: [embed] });
    await interaction.update({ content: `Sent "${record.title}" to your DMs!`, embeds: [], components: [] });
  } catch (err) {
    console.error('Saved Messages: DM delivery failed:', err.message);
    await interaction.update({ content: "Couldn't DM you - please make sure DMs from server members are enabled, then try again.", embeds: [], components: [] });
  }
}

// ---------------------------------------------------------------------------
// registerSavedMessages(client)
// ---------------------------------------------------------------------------
function registerSavedMessagesImpl(client) {
  client.once('ready', () => {
    loadSavedMessagesFromDiscord(client).then(() => ensureStickyButton(client));
  });

  client.on('messageDelete', async (message) => {
    if (!SAVED_MESSAGES_CHANNEL_ID || message.channelId !== SAVED_MESSAGES_CHANNEL_ID) return;
    if (message.id !== stickyMessageId) return;
    stickyMessageId = null;
    await ensureStickyButton(client);
  });

  client.on('messageDeleteBulk', async (messages) => {
    if (!SAVED_MESSAGES_CHANNEL_ID) return;
    const first = messages.first();
    if (!first || first.channelId !== SAVED_MESSAGES_CHANNEL_ID) return;
    if (!messages.has(stickyMessageId)) return;
    stickyMessageId = null;
    await ensureStickyButton(client);
  });

  // Fulfils a pending "waiting for an image" window - from either a fresh
  // save or an "Update Image" click on an existing message.
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!SAVED_MESSAGES_CHANNEL_ID || message.channel.id !== SAVED_MESSAGES_CHANNEL_ID) return;
    const wait = pendingImageWait.get(message.author.id);
    if (!wait) return;
    const image = message.attachments.find(a => a.contentType && a.contentType.startsWith('image/'));
    if (!image) return;

    const records = SAVED_MESSAGES[message.author.id] || [];
    const record = records.find(r => r.id === wait.messageId);
    if (!record) {
      pendingImageWait.delete(message.author.id);
      return;
    }
    record.imageUrl = image.url;
    pendingImageWait.delete(message.author.id);
    await saveSavedMessagesToDiscord(client);
    await message.reply(`Image attached to "${record.title}"!`);
  });

  function armImageWait(userId, messageId) {
    pendingImageWait.set(userId, { messageId, expiresAt: Date.now() + IMAGE_WAIT_MS });
    setTimeout(() => {
      const w = pendingImageWait.get(userId);
      if (w && w.messageId === messageId) pendingImageWait.delete(userId);
    }, IMAGE_WAIT_MS + 1000);
  }

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
    if (!SAVED_MESSAGES_CHANNEL_ID || interaction.channelId !== SAVED_MESSAGES_CHANNEL_ID) return;
    const id = interaction.customId;
    if (!id.startsWith('sm_')) return; // not ours

    try {
      if (id === 'sm_start') {
        await interaction.reply({ ...buildMenuChoiceButtons(), ephemeral: true });
        return;
      }

      if (id === 'sm_save') {
        if (getDistinctCategories().length) {
          await interaction.update(buildSaveCategorySelect());
        } else {
          await interaction.showModal(buildMessageModal('sm_savemodal'));
        }
        return;
      }

      if (id === 'sm_savecat') {
        const value = interaction.values[0];
        const prefill = value === '__new__' ? {} : { category: value };
        await interaction.showModal(buildMessageModal('sm_savemodal', prefill));
        return;
      }

      if (id === 'sm_get') {
        if (!getDistinctCategories().length) {
          await interaction.update({ content: "Nothing's been saved yet.", embeds: [], components: [] });
          return;
        }
        await interaction.update(buildGetCategorySelect());
        return;
      }

      if (id === 'sm_getcat') {
        const category = interaction.values[0];
        const records = getRecordsInCategory(category);
        if (!records.length) {
          await interaction.update({ content: 'No messages left in that category.', embeds: [], components: [] });
          return;
        }
        const ownerIds = [...new Set(records.map(r => r.ownerId))];
        const memberNames = new Map();
        for (const ownerId of ownerIds) memberNames.set(ownerId, await resolveDisplayName(interaction.guild, ownerId));
        await interaction.update(buildCategoryRecordsSelect(records, memberNames));
        return;
      }

      if (id === 'sm_gettitle') {
        const [ownerId, recordIdStr] = interaction.values[0].split(':');
        const record = (SAVED_MESSAGES[ownerId] || []).find(r => r.id === Number(recordIdStr));
        if (!record) {
          await interaction.update({ content: 'That message no longer exists.', embeds: [], components: [] });
          return;
        }
        await deliverSavedMessage(interaction, record);
        return;
      }

      if (id === 'sm_mine') {
        const records = SAVED_MESSAGES[interaction.user.id] || [];
        if (!records.length) {
          await interaction.update({ content: "You haven't saved any messages yet.", embeds: [], components: [] });
          return;
        }
        await interaction.update(buildOwnTitleSelect(records));
        return;
      }

      if (id === 'sm_minetitle') {
        const records = SAVED_MESSAGES[interaction.user.id] || [];
        const record = records.find(r => r.id === Number(interaction.values[0]));
        if (!record) {
          await interaction.update({ content: 'That message no longer exists.', embeds: [], components: [] });
          return;
        }
        await interaction.update({ content: null, embeds: [buildPreviewEmbed(record)], components: [buildManageButtons(record)] });
        return;
      }

      const editButtonMatch = id.match(/^sm_edittext_(\d+)$/);
      if (editButtonMatch) {
        const messageId = Number(editButtonMatch[1]);
        const record = (SAVED_MESSAGES[interaction.user.id] || []).find(r => r.id === messageId);
        if (!record) {
          await interaction.reply({ content: 'That message no longer exists.', ephemeral: true });
          return;
        }
        await interaction.showModal(buildMessageModal(`sm_editmodal_${messageId}`, record));
        return;
      }

      const updateImageMatch = id.match(/^sm_updateimage_(\d+)$/);
      if (updateImageMatch) {
        const messageId = Number(updateImageMatch[1]);
        const record = (SAVED_MESSAGES[interaction.user.id] || []).find(r => r.id === messageId);
        if (!record) {
          await interaction.reply({ content: 'That message no longer exists.', ephemeral: true });
          return;
        }
        armImageWait(interaction.user.id, messageId);
        await interaction.reply({ content: `Post a new image in this channel within 2 minutes to update the image for "${record.title}".`, ephemeral: true });
        return;
      }

      if (interaction.isModalSubmit()) {
        if (id === 'sm_savemodal') {
          const category = interaction.fields.getTextInputValue('sm_category').trim();
          const title = interaction.fields.getTextInputValue('sm_title').trim();
          const text = interaction.fields.getTextInputValue('sm_text').trim();
          const record = { id: Date.now(), category, title, text, imageUrl: null };
          if (!SAVED_MESSAGES[interaction.user.id]) SAVED_MESSAGES[interaction.user.id] = [];
          SAVED_MESSAGES[interaction.user.id].push(record);
          await saveSavedMessagesToDiscord(interaction.client);

          armImageWait(interaction.user.id, record.id);
          await interaction.reply({
            content: `Saved "${title}" under "${category}"! Want an image with it? Post one in this channel within the next 2 minutes and I'll attach it automatically.`,
            ephemeral: true,
          });
          return;
        }

        const editModalMatch = id.match(/^sm_editmodal_(\d+)$/);
        if (editModalMatch) {
          const messageId = Number(editModalMatch[1]);
          const record = (SAVED_MESSAGES[interaction.user.id] || []).find(r => r.id === messageId);
          if (!record) {
            await interaction.reply({ content: 'That message no longer exists.', ephemeral: true });
            return;
          }
          record.category = interaction.fields.getTextInputValue('sm_category').trim();
          record.title = interaction.fields.getTextInputValue('sm_title').trim();
          record.text = interaction.fields.getTextInputValue('sm_text').trim();
          await saveSavedMessagesToDiscord(interaction.client);
          await interaction.reply({ content: `Updated "${record.title}"!`, ephemeral: true });
          return;
        }
      }
    } catch (err) {
      console.error('Saved Messages error:', err.message);
      const errorReply = { content: 'Something went wrong - please click Messages again.', embeds: [], components: [] };
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(errorReply);
        } else {
          await interaction.reply({ ...errorReply, ephemeral: true });
        }
      } catch (_) { /* interaction likely already gone */ }
    }
  });
}

module.exports = { registerSavedMessages: registerSavedMessagesImpl };
