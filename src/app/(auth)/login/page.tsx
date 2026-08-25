import { getTranslations } from "next-intl/server";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LanguageToggle } from "@/components/language-toggle";
import { login } from "./actions";
import { LoginSubmit } from "./submit-button";

/** Query-string error codes this page knows how to explain. */
const ERROR_KEYS: Record<string, string> = {
  invalid: "invalidCredentials",
  nomember: "noMembership",
  invalid_link: "invalidLink",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const t = await getTranslations("auth");
  const tc = await getTranslations("common");
  const { error } = await searchParams;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        <span className="flex size-8 items-center justify-center rounded-md bg-primary font-mono text-sm text-primary-foreground">
          C
        </span>
        {tc("appName")}
      </div>

      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={login} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">{t("email")}</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">{t("password")}</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            {/* One lookup, so an error code added later cannot land here
                silently. `invalid_link` is what /auth/confirm redirects to when
                an invitation link is expired or already used — without a
                message the recipient just sees an empty form and assumes the
                product is broken. */}
            {error && ERROR_KEYS[error] && (
              <p role="alert" className="text-sm text-destructive">
                {t(ERROR_KEYS[error])}
              </p>
            )}
            <LoginSubmit label={t("submit")} pendingLabel={t("submitPending")} />
          </form>
        </CardContent>
      </Card>

      <LanguageToggle />
    </main>
  );
}
