"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/authz";
import { validatedAction, uuid } from "@/lib/validation";
import { writeAudit } from "@/lib/audit";

/**
 * Announcements.
 *
 * `news.manage` is the permission the role map already assigns to HR and
 * company admins, and `news_hr` in migration 0002 requires it again in the
 * database — so a dispatcher who reached this action would be refused twice.
 *
 * Publishing is a timestamp, not a boolean: `news_select` shows members posts
 * where `published_at is not null`, so clearing it genuinely withdraws a post
 * rather than hiding it behind a filter the client could ignore.
 */

export type NewsOutcome = { kind: "saved"; postId: string } | { kind: "refused" };

export const publishAnnouncement = validatedAction(
  z.object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(4000),
    category: z.string().trim().max(60).optional(),
    /** Save as a draft instead of publishing immediately. */
    draft: z.boolean().optional(),
  }),
  async (input): Promise<NewsOutcome> => {
    const ctx = await requirePermission("news.manage");

    const { data, error } = await ctx.supabase
      .from("news_posts")
      .insert({
        company_id: ctx.membership.company_id,
        title: input.title,
        body: input.body,
        category: input.category || null,
        author_id: ctx.userId,
        published_at: input.draft ? null : new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !data) return { kind: "refused" };

    await writeAudit(ctx, {
      action: input.draft ? "news.drafted" : "news.published",
      entity: "news_posts",
      entityId: data.id as string,
      diff: { title: input.title },
    });

    revalidatePath("/app/news");
    revalidatePath("/me");
    return { kind: "saved", postId: data.id as string };
  }
);

export const setAnnouncementPublished = validatedAction(
  z.object({ postId: uuid, published: z.boolean() }),
  async (input): Promise<NewsOutcome> => {
    const ctx = await requirePermission("news.manage");

    const { data, error } = await ctx.supabase
      .from("news_posts")
      .update({ published_at: input.published ? new Date().toISOString() : null })
      // The company filter is belt and braces over `news_hr`; it makes the
      // tenant boundary visible in the code a reviewer reads.
      .eq("company_id", ctx.membership.company_id)
      .eq("id", input.postId)
      .select("id")
      .maybeSingle();
    if (error || !data) return { kind: "refused" };

    await writeAudit(ctx, {
      action: input.published ? "news.published" : "news.unpublished",
      entity: "news_posts",
      entityId: input.postId,
    });

    revalidatePath("/app/news");
    revalidatePath("/me");
    return { kind: "saved", postId: input.postId };
  }
);
