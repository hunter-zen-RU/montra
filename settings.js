const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

module.exports = {
  name: 'Montra',
  version: 'v1.2.0-splash',
  ownerNumber: String(process.env.BOT_OWNER_NUMBER || '').replace(/[^0-9]/g, ''),
  dataDir: path.join(__dirname, 'data')
};
