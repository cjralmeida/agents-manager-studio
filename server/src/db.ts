import { PrismaPg } from '@prisma/adapter-pg';
import { config } from './config.js';
import { PrismaClient } from './generated/prisma/client.js';

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl }),
});
