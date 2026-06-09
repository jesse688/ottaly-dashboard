import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Nav } from "@/components/nav";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Ottaly Admin",
  description: "Ottaly agency dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} h-full`}>
      <body className="h-full" style={{ marginLeft: 65, background: '#F0F2F8', fontFamily: 'Inter, -apple-system, sans-serif', color: '#050C29' }}>
        <Nav />
        <main className="min-h-screen">{children}</main>
      </body>
    </html>
  );
}
