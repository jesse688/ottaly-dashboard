import type { Metadata } from "next";
import { Inter, Genos } from "next/font/google";
import { Sidebar } from "@/components/shell/sidebar";
import { SidebarProvider } from "@/components/shell/sidebar-state";
import { AppMain } from "@/components/shell/app-main";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/components/theme-provider";
import "./globals.css";

// Inter = body/UI; Genos = Ottaly's brand display font (logo, headings, big numbers).
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const genos = Genos({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-genos",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ottaly Admin",
  description: "Ottaly agency dashboard",
  icons: { icon: "/logo-navy.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${genos.variable} dark h-full`} suppressHydrationWarning>
      <head>
        {/* Set theme class before paint to avoid a flash of the wrong theme. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="h-full bg-background font-sans text-foreground antialiased">
        <ThemeProvider>
          <SidebarProvider>
            <Sidebar />
            <AppMain>{children}</AppMain>
          </SidebarProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
