import { notFound } from "next/navigation";
import { PortalApp } from "../PortalApp";
import { portalViewForPath } from "../lib/portal-routes";

export const dynamic = "force-dynamic";

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!portalViewForPath(`/${section}`)) notFound();
  return <PortalApp />;
}
