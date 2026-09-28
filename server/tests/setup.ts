import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each test file gets its own throw-away data directory / database.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-test-'));
process.env.DATA_DIR = dir;
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_PASSWORD = 'admin123';
