import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";

export const SUPPORTED_LOCALES = ["de", "en"] as const;
export const DEFAULT_LOCALE = "de";

export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieLocale = store.get("locale")?.value;
  const locale = SUPPORTED_LOCALES.includes(cookieLocale as "de" | "en")
    ? (cookieLocale as "de" | "en")
    : DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
