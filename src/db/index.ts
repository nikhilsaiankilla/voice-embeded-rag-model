import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres"

import * as schema from './schema'

let client: ReturnType<typeof postgres> | null;
let db: PostgresJsDatabase<typeof schema> | null;

export const getDb = async () => {
    if (db) return db;

    const databaseUrl = process.env.DATABASE_URL!

    if (!databaseUrl) {
        throw new Error('DATABASE_URL is not set');
    }

    try {
        client = postgres(databaseUrl, {
            prepare: false,
            max: 1,
        })

        db = drizzle(client, { schema })

        return db;
    } catch (err) {
        // log once and rethrow
        console.error('[db] failed to connect', err);
        throw err;
    }
} 