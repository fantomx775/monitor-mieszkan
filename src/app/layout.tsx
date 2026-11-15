import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nocny Monitor Nieruchomości",
  description: "Prywatny monitoring ofert mieszkań na sprzedaż.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pl">
      <body>{children}</body>
    </html>
  );
}
