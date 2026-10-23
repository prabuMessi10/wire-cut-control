import 'dotenv/config';
import mongoose from 'mongoose';
import { ensureBootstrapAdmin } from '../src/services/bootstrapAdmin.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/wire_cut_control';

async function run() {
  if (process.env.MONGODB_MEMORY === 'true') {
    console.log('[seed] MONGODB_MEMORY=true detected - an in-memory MongoDB cannot be');
    console.log('       shared across processes, so with memory mode the admin is');
    console.log('       auto-created when the server starts.');
    console.log('       Just run `npm run dev` and sign in with ADMIN_EMAIL /');
    console.log('       ADMIN_PASSWORD from server/.env.');
    process.exit(0);
  }

  console.log(`[seed] connecting to MongoDB at ${MONGO_URI}`);
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });

  const { created, admin } = await ensureBootstrapAdmin();

  if (!created) {
    console.log(`[seed] an admin already exists (${admin.email}) - nothing to do.`);
    console.log('       To reset it, delete that document and re-run the seed.');
  } else {
    console.log('[seed] bootstrap admin created:');
    console.log(`        name     : ${admin.name}`);
    console.log(`        email    : ${admin.email}`);
    console.log(`        password : the value of ADMIN_PASSWORD in server/.env`);
    console.log(`        role     : admin (status: approved)`);
  }

  await mongoose.disconnect();
  console.log('[seed] done.');
}

run().catch((err) => {
  console.error('[seed] failed:', err.message);
  process.exit(1);
});