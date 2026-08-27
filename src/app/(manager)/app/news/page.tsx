import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { roleHas } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { NewsComposer, PublishToggle } from "./news-forms";

/**
 * Company announcements.
 *
 * `news_posts` and its policies already exist: members read published posts,
 * HR manages everything. So the page is thin — it renders what RLS returns and
 * gates the composer on the same permission the Server Action requires.
 *
 * An unpublished post is visible here only because `news_hr` grants HR full
 * access; an employee's query cannot return it, because `news_select` requires
 * `published_at is not null`. Draft state is therefore enforced by the
 * database, not by a filter in this file.
 */
export const dynamic = "force-dynamic";

type NewsRow = {
  id: string;
  title: string;
  body: string;
  category: string | null;
  published_at: string | null;
  created_at: string;
  profiles: { full_name: string } | null;
};

export default async function NewsPage() {
  const ctx = await getShellContext();
  const t = await getTranslations("news");
  const locale = await getLocale();
  const canManage = roleHas(ctx.membership.role, "news.manage");

  const { data } = await ctx.supabase
    .from("news_posts")
    .select("id, title, body, category, published_at, created_at, profiles(full_name)")
    .eq("company_id", ctx.membership.company_id)
    .order("created_at", { ascending: false })
    .limit(40);

  const posts = (data ?? []) as unknown as NewsRow[];
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-xs text-muted-foreground">
          {canManage ? t("managerIntro") : t("readOnlyIntro")}
        </p>
      </div>

      {canManage && <NewsComposer />}

      {posts.length === 0 ? (
        <EmptyState title={t("none")} body={canManage ? t("noneBody") : undefined} />
      ) : (
        <div className="flex flex-col gap-2">
          {posts.map((post) => (
            <article key={post.id} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{post.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {post.profiles?.full_name ?? "—"}
                    {" · "}
                    {fmt(post.published_at ?? post.created_at)}
                    {post.category ? ` · ${post.category}` : ""}
                  </p>
                </div>
                <Badge variant={post.published_at ? "success" : "secondary"}>
                  {t(post.published_at ? "published" : "draft")}
                </Badge>
              </div>

              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{post.body}</p>

              {canManage && (
                <PublishToggle postId={post.id} published={post.published_at !== null} />
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
