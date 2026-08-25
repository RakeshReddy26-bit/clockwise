import { getTranslations } from "next-intl/server";
import { ComingSoon } from "@/components/coming-soon";

export default async function Page() {
  const t = await getTranslations("managerNav");
  const tp = await getTranslations("planned");
  return <ComingSoon title={t("calendar")} note={tp("calendar")} backHref="/app" />;
}
