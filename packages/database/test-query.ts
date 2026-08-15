import { createDbConnection } from './src/db';
import * as dotenv from 'dotenv';

dotenv.config();

async function run() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is missing');
  }
  
  const db = createDbConnection(process.env.DATABASE_URL);
  
  console.log("Querying users...");
  const allUsers = await db.query.users.findMany({ limit: 5 });
  console.log(`Found ${allUsers.length} users:`);
  console.log(allUsers);

  console.log("\nQuerying vessels...");
  const allVessels = await db.query.vessels.findMany({ limit: 5 });
  console.log(`Found ${allVessels.length} vessels:`);
  console.log(allVessels);

  process.exit(0);
}

run().catch(console.error);
