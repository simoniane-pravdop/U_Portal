import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") || incoming.get("host") || "localhost:3000";
  const protocol = incoming.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  const title = "Управлінський портал · Правова Допомога";
  const description = "Стратегічні цілі, управлінські цикли, завдання, блокери, рішення та звітність в одному дереві.";
  return {
    title,
    description,
    openGraph: { title, description, type: "website", locale: "uk_UA", images: [{ url: image, width: 1536, height: 1024, alt: "Управлінський портал — цілі, цикли та рішення" }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="uk"><body>{children}</body></html>;
}
