import { internalMutationGeneric, internalQueryGeneric } from 'convex/server';
import type { DataModelFromSchemaDefinition, MutationBuilder, QueryBuilder } from 'convex/server';
import schema from './schema';
type DataModel = DataModelFromSchemaDefinition<typeof schema>;
const mutation = internalMutationGeneric as MutationBuilder<DataModel, 'internal'>;
const query = internalQueryGeneric as QueryBuilder<DataModel, 'internal'>;
import { v } from 'convex/values';

type ArticleRow = DataModel['articles']['document'];
type Metadata = Omit<ArticleRow, '_id' | '_creationTime' | 'contentId'>;
const summary = (doc: Metadata & {contentId?: unknown; _id?: unknown; _creationTime?: unknown}): Metadata => {
  const {_id, _creationTime, contentId, ...fields} = doc;
  return {...fields, unread:doc.unread ?? true, readUpdated:doc.readUpdated ?? 0, archived:doc.archived ?? false, deleted:doc.deleted ?? false,lifecycleUpdated:doc.lifecycleUpdated ?? 0};
};
const deletedSummary = (id:string,lifecycleUpdated:number):Metadata => ({id,title:'Deleted article',source:'',tags:[],words:0,position:0,updated:0,metadataUpdated:0,contentUpdated:0,unread:true,readUpdated:0,archived:false,deleted:true,lifecycleUpdated});
export const list = query({args: {includeDeleted:v.optional(v.boolean())}, handler: async (ctx,args) => {
  const rows = await ctx.db.query('articles').collect();
  if (!args.includeDeleted) return rows.filter(row=>!row.deleted).map(summary);
  const known = new Set(rows.map(row=>row.id));
  const tombstones = await ctx.db.query('tombstones').collect();
  return [...rows.map(summary),...tombstones.filter(t=>!known.has(t.id)).map(t=>deletedSummary(t.id,t.lifecycleUpdated))];
}});
export const get = query({args: {id:v.string()}, handler: async (ctx,args) => {
  return await ctx.db.query('articles').withIndex('by_article_id', q => q.eq('id',args.id)).unique();
}});
export const upsert = mutation({args: {
  id:v.string(), title:v.string(), source:v.string(), tags:v.array(v.string()), position:v.number(),
  updated:v.number(), metadataUpdated:v.number(), contentUpdated:v.number(), unread:v.optional(v.boolean()), readUpdated:v.optional(v.number()), archived:v.optional(v.boolean()),deleted:v.optional(v.boolean()),lifecycleUpdated:v.optional(v.number()), words:v.number(), contentId:v.id('_storage'),
}, handler: async (ctx,args) => {
  if ((args.unread === undefined) !== (args.readUpdated === undefined)) throw new Error('unread and readUpdated must be supplied together.');
  if ([args.archived,args.deleted,args.lifecycleUpdated].some(v=>v!==undefined) && [args.archived,args.deleted,args.lifecycleUpdated].some(v=>v===undefined)) throw new Error('Lifecycle fields must be supplied together.');
  const existing = await ctx.db.query('articles').withIndex('by_article_id', q => q.eq('id',args.id)).unique();
  const tombstone = await ctx.db.query('tombstones').withIndex('by_article_id',q=>q.eq('id',args.id)).unique();
  if (tombstone || existing?.deleted) return {document:existing ? summary(existing) : deletedSummary(args.id,tombstone!.lifecycleUpdated),discardContentId:args.contentId,replacedContentId:null,ignored:true};
  if (!existing) {
    await ctx.db.insert('articles',args);
    if (args.deleted) await ctx.db.insert('tombstones',{id:args.id,lifecycleUpdated:args.lifecycleUpdated!});
    return {document:summary(args), discardContentId:null, replacedContentId:null};
  }
  const patch: Partial<Omit<ArticleRow, '_id' | '_creationTime'>> = {};
  const newerContent = args.contentUpdated > existing.contentUpdated;
  const wordCount = newerContent ? args.words : existing.words;
  if (newerContent) Object.assign(patch, {contentId:args.contentId, contentUpdated:args.contentUpdated, words:args.words});
  if (args.updated > existing.updated) Object.assign(patch, {position:Math.min(args.position,wordCount-1), updated:args.updated});
  else if (newerContent) patch.position = Math.min(existing.position,wordCount-1);
  if (args.metadataUpdated > existing.metadataUpdated) Object.assign(patch, {title:args.title, source:args.source, tags:args.tags, metadataUpdated:args.metadataUpdated});
  if (args.readUpdated !== undefined && args.readUpdated > (existing.readUpdated ?? -1)) Object.assign(patch, {unread:args.unread, readUpdated:args.readUpdated});
  if (args.lifecycleUpdated !== undefined && args.lifecycleUpdated > (existing.lifecycleUpdated ?? -1)) {
    Object.assign(patch,{archived:args.archived,deleted:args.deleted,lifecycleUpdated:args.lifecycleUpdated});
    if (args.deleted) await ctx.db.insert('tombstones',{id:args.id,lifecycleUpdated:args.lifecycleUpdated});
  }
  await ctx.db.patch(existing._id,patch);
  return {document:summary({...existing,...patch}), discardContentId:newerContent ? null : args.contentId,
    replacedContentId:newerContent ? existing.contentId : null};
}});
export const progress = mutation({args:{id:v.string(),position:v.number(),updated:v.number()}, handler:async(ctx,args) => {
  const doc = await ctx.db.query('articles').withIndex('by_article_id', q => q.eq('id',args.id)).unique();
  const tombstone = await ctx.db.query('tombstones').withIndex('by_article_id',q=>q.eq('id',args.id)).unique();
  if (doc?.deleted || tombstone) return {id:args.id,position:doc?.position ?? 0,updated:doc?.updated ?? 0,deleted:true,ignored:true};
  if (!doc) return null;
  if (args.updated > doc.updated) {
    const position = Math.min(args.position,doc.words-1);
    await ctx.db.patch(doc._id,{position,updated:args.updated});
    return {id:doc.id,position,updated:args.updated};
  }
  return {id:doc.id,position:doc.position,updated:doc.updated};
}});
export const setTags = mutation({args:{id:v.string(),tags:v.array(v.string()),metadataUpdated:v.number()}, handler:async(ctx,args) => {
  const doc = await ctx.db.query('articles').withIndex('by_article_id', q => q.eq('id',args.id)).unique();
  const tombstone = await ctx.db.query('tombstones').withIndex('by_article_id',q=>q.eq('id',args.id)).unique();
  if (doc?.deleted || tombstone) return {id:args.id,tags:doc?.tags ?? [],metadataUpdated:doc?.metadataUpdated ?? 0,deleted:true,ignored:true};
  if (!doc) return null;
  if (args.metadataUpdated > doc.metadataUpdated) {
    await ctx.db.patch(doc._id,{tags:args.tags,metadataUpdated:args.metadataUpdated});
    return {id:doc.id,tags:args.tags,metadataUpdated:args.metadataUpdated};
  }
  return {id:doc.id,tags:doc.tags,metadataUpdated:doc.metadataUpdated};
}});
export const setReadStatus = mutation({args:{id:v.string(),unread:v.boolean(),readUpdated:v.number()}, handler:async(ctx,args) => {
  const doc = await ctx.db.query('articles').withIndex('by_article_id', q => q.eq('id',args.id)).unique();
  const tombstone = await ctx.db.query('tombstones').withIndex('by_article_id',q=>q.eq('id',args.id)).unique();
  if (doc?.deleted || tombstone) return {id:args.id,unread:doc?.unread ?? true,readUpdated:doc?.readUpdated ?? 0,deleted:true,ignored:true};
  if (!doc) return null;
  if (args.readUpdated > (doc.readUpdated ?? -1)) {
    await ctx.db.patch(doc._id,{unread:args.unread,readUpdated:args.readUpdated});
    return {id:doc.id,unread:args.unread,readUpdated:args.readUpdated};
  }
  return {id:doc.id,unread:doc.unread ?? true,readUpdated:doc.readUpdated ?? 0};
}});
export const setLifecycle = mutation({args:{id:v.string(),archived:v.boolean(),deleted:v.boolean(),lifecycleUpdated:v.number()},handler:async(ctx,args)=>{
  const doc=await ctx.db.query('articles').withIndex('by_article_id',q=>q.eq('id',args.id)).unique();
  const tombstone=await ctx.db.query('tombstones').withIndex('by_article_id',q=>q.eq('id',args.id)).unique();
  if (tombstone || doc?.deleted) return {id:args.id,archived:doc?.archived ?? false,deleted:true,lifecycleUpdated:doc?.lifecycleUpdated ?? tombstone!.lifecycleUpdated,ignored:true};
  if (!doc && !args.deleted) return null;
  if (!doc || args.lifecycleUpdated > (doc.lifecycleUpdated ?? -1)) {
    if (args.deleted) await ctx.db.insert('tombstones',{id:args.id,lifecycleUpdated:args.lifecycleUpdated});
    if (doc) await ctx.db.patch(doc._id,{archived:args.archived,deleted:args.deleted,lifecycleUpdated:args.lifecycleUpdated});
    return args;
  }
  return {id:doc.id,archived:doc.archived ?? false,deleted:doc.deleted ?? false,lifecycleUpdated:doc.lifecycleUpdated ?? 0};
}});
export const addImage = mutation({args:{storageId:v.id('_storage'),mime:v.string(),bytes:v.number()}, handler:async(ctx,args) => {await ctx.db.insert('images',args);}});
export const getImage = query({args:{storageId:v.string()}, handler:async(ctx,args) => {
  const id = ctx.db.system.normalizeId('_storage',args.storageId);
  if (!id) return null;
  return await ctx.db.query('images').withIndex('by_storage_id', q => q.eq('storageId',id)).unique();
}});
