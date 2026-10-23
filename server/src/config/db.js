import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';

const DEFAULT_URI = 'mongodb://127.0.0.1:27017/wire_cut_control';

/**
 * Look for an already-downloaded mongod binary so the in-memory fallback
 * boots instantly instead of re-downloading ~600 MB. Lookup order:
 *   1. MONGOD_BIN env var (explicit path to a mongod binary)
 *   2. MONGOMS_SYSTEM_BINARY (set it yourself if you know where mongod lives)
 *   3. The mongodb-memory-server cache dirs under the current user's home
 * Returns null when nothing is found; mongodb-memory-server will then download
 * the binary once (see README.md -> "Running without MongoDB installed").
 */
function findSystemMongod() {
  if (process.env.MONGOD_BIN && fs.existsSync(process.env.MONGOD_BIN)) {
    return process.env.MONGOD_BIN;
  }
  if (process.env.MONGOMS_SYSTEM_BINARY) {
    return process.env.MONGOMS_SYSTEM_BINARY;
  }

  const isMongod = (f) =>
    f === 'mongod' ||
    (f.startsWith('mongod-') && !/\.(zip|tgz|gz|downloading|lock)$/i.test(f));

  const dirs = [
    path.join(os.homedir(), '.cache', 'mongodb-binaries'),
    path.join(os.homedir(), '.cache', 'mongodb-memory-server', 'mongodb-binaries'),
  ];
  for (const dir of dirs) {
    try {
      const found = fs.readdirSync(dir).find(isMongod);
      if (found) return path.join(dir, found);
    } catch {
      // dir missing or unreadable - try the next one
    }
  }
  return null;
}

/**
 * Connect to MongoDB.
 *
 * Default:     real MongoDB at MONGO_URI (server/.env).
 * Dev fallback: when MONGODB_MEMORY=true an in-memory MongoDB is started
 *               automatically (mongodb-memory-server) so the whole stack runs
 *               with zero installation. Data is ephemeral (lost on restart).
 */
export async function connectDB({ retries = 6, retryDelayMs = 5000 } = {}) {
  let uri = process.env.MONGO_URI || DEFAULT_URI;

  if (process.env.MONGODB_MEMORY === 'true') {
    const systemBinary = findSystemMongod();
    if (systemBinary) {
      process.env.MONGOMS_SYSTEM_BINARY = systemBinary;
      console.log(
        `[db] MONGODB_MEMORY=true -> in-memory MongoDB via cached mongod: ${systemBinary}`
      );
    } else {
      console.log(
        '[db] MONGODB_MEMORY=true -> in-memory MongoDB ' +
          '(no cached mongod found; the first run may download ~600 MB, see README)'
      );
    }
    try {
      const { MongoMemoryServer } = await import('mongodb-memory-server');
      const mongod = await MongoMemoryServer.create();
      uri = mongod.getUri('wire_cut_control');
      process.env.MONGO_URI = uri;
      console.log('[db] in-memory MongoDB ready (ephemeral - data is lost on restart)');
    } catch (err) {
      throw new Error(
        `MONGODB_MEMORY=true but the in-memory MongoDB could not start: ${err.message}`
      );
    }
  }

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
      console.log(`[db] connected to MongoDB (${mongoose.connection.name})`);
      break;
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`[db] connection attempt ${attempt}/${retries} failed: ${msg}`);
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      } else {
        throw new Error(
          `Could not connect to MongoDB at ${uri}. ` +
            'Make sure mongod is running locally (or set MONGO_URI in server/.env). ' +
            'No MongoDB installed? Set MONGODB_MEMORY=true in server/.env. See README.md.'
        );
      }
    }
  }

  mongoose.connection.on('disconnected', () => console.warn('[db] MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => console.log('[db] MongoDB reconnected'));
  mongoose.connection.on('error', (err) => console.error('[db] MongoDB error:', err.message));
}