import 'dotenv/config';
import app from './app.js';
import { connectDB } from './config/db.js';
import { ensureBootstrapAdmin } from './services/bootstrapAdmin.js';

const PORT = Number(process.env.PORT) || 5000;

async function main() {
  await connectDB();

  // In memory mode the DB is ephemeral, so a separate seed process cannot
  // persist the admin - bootstrap it here instead (idempotent).
  if (process.env.MONGODB_MEMORY === 'true') {
    const { created, admin } = await ensureBootstrapAdmin();
    console.log(
      created
        ? `[bootstrap] admin account created: ${admin.email}`
        : `[bootstrap] admin account present: ${admin.email}`
    );
  }

  app.listen(PORT, () => {
    console.log('----------------------------------------');
    console.log('  Wire Cut Control API');
    console.log(`  http://localhost:${PORT}/api/health`);
    console.log('----------------------------------------');
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[server] Port ${PORT} is already in use by another process.`);
      console.error('         Close the other Node.js app first, then restart.');
      console.error('         Find it with:  netstat -ano | findstr :' + PORT);
      console.error('         Or look for "Node.js (JavaScript)" in Task Manager.\n');
      process.exit(1);
    }
    throw err;
  });
}

main().catch((err) => {
  console.error('\n[server] Failed to start:');
  console.error(' ', err.message);
  console.error('\nCheck server/.env (MONGO_URI) and make sure MongoDB is running.');
  console.error('No MongoDB? Set MONGODB_MEMORY=true in server/.env (see README.md).');
  process.exit(1);
});