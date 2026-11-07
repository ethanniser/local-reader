import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  articles: defineTable({
    id: v.string(), title: v.string(), source: v.string(), tags: v.array(v.string()),
    position: v.number(), updated: v.number(), metadataUpdated: v.number(),
    unread: v.optional(v.boolean()), readUpdated: v.optional(v.number()),
    archived:v.optional(v.boolean()), deleted:v.optional(v.boolean()), lifecycleUpdated:v.optional(v.number()),
    contentUpdated: v.number(), words: v.number(), contentId: v.id('_storage'),
  }).index('by_article_id', ['id']),
  tombstones: defineTable({id:v.string(), lifecycleUpdated:v.number()}).index('by_article_id',['id']),
  images: defineTable({storageId: v.id('_storage'), mime: v.string(), bytes: v.number()})
    .index('by_storage_id', ['storageId']),
});
