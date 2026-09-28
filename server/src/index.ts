import { config } from './config.js';
import { getDb } from './db/index.js';
import { createApp } from './app.js';

getDb(); // open + migrate before accepting requests

const app = createApp();
app.listen(config.port, () => {
  console.log(`Warehouse IMS API listening on http://localhost:${config.port} (${config.env})`);
  console.log(`Database: ${config.dbFile}`);
});
