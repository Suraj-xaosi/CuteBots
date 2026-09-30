import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client.js";

const globalPrisma = globalThis as typeof globalThis & { cutebotsPrisma?: PrismaClient };

export const prisma = globalPrisma.cutebotsPrisma ?? new PrismaClient({
	adapter: new PrismaBetterSqlite3({
		url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
	}),
});

if (process.env.NODE_ENV !== "production") globalPrisma.cutebotsPrisma = prisma;