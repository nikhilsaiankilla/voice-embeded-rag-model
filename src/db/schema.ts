import { pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const documents = pgTable('documents', {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceName: text("source_name").notNull(),
    sourceType: text("source_type").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
})

export const chatSessions = pgTable("chat_sessions", {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar('title'),
    createdAt: timestamp("created_at").defaultNow(),
    lastActiveAt: timestamp("last_active_at").defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").references(() => chatSessions.id).notNull(),
    role: text("role").notNull(), // 'user' | 'assistant'
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
});