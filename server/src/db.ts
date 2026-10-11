import { PrismaPg } from '@prisma/adapter-pg';
import { config } from './config.js';
import { PrismaClient } from './generated/prisma/client.js';

export const prisma = new PrismaClient({
  // Timestamps go to the database without an offset: the session must be in UTC, whatever the database default.
  adapter: new PrismaPg({ connectionString: config.databaseUrl, options: '-c TimeZone=UTC' }),
});
