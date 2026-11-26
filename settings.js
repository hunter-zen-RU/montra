const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

module.exports = {
  name: 'Montra',
  version: 'v1.3.0',
  ownerNumber: String(process.env.BOT_OWNER_NUMBER || '').replace(/[^0-9]/g, ''),
  dataDir: path.join(__dirname, 'data')
};

// Loaded last so module.exports above is complete before lib/telegramEngine
// requires '../settings' mid-cycle. This registers the v1.3.0 Telegram feature
// commands (message bookmarks, formatted /export) as a plugin on the engine —
// see lib/featureCommands.js. index.js loads settings.js before the bridge
// starts, so the registration is in place before TelegramEngine.init().
require('./lib/featureCommands');
