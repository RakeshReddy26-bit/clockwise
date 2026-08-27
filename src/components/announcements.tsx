import { getTranslations, getLocale } from "next-intl/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Megaphone } from "lucide-react";

/**
 * Recent announcements on the employee home.
 *
 * `news_select` returns only published posts to a member, so there is no
 * `published_at is not null` filter here — adding one would imply the page is
 * what keeps a draft private, and it is not.
 *
 * Renders nothing when there is nothing to say, rather than an empty card.
 */
export async function Announcements({
  supabase,
  companyId,
  limit = 3,
}: {
  supabase: SupabaseClient;
  companyId: string;
  limit?: number;
}) {
  const t = await getTranslations("news");
  const locale = await getLocale();

  const { data } = await supabase
    .from("news_posts")
    .select("id, title, body, published_at")
    .eq("company_id", companyId)
    .order("published_at", { ascending: false })
    .limit(limit);

  const posts = (data ?? []) as Array<{
    id: string;
    title: string;
    body: string;
    published_at: string | null;
  }>;
  if (posts.length === 0) return null;

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" }) : "";

  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
        <Megaphone className="size-4" />
        {t("employeeSectionTitle")}
      </h2>

      {posts.map((post) => (
        <article key={post.id} className="rounded-lg border bg-card p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">{post.title}</p>
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {fmt(post.published_at)}
            </p>
          </div>
          {/* Announcements are short by convention; clamping keeps the home
              screen scannable without hiding a one-paragraph notice. */}
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
            {post.body}
          </p>
        </article>
      ))}
    </section>
  );
}
