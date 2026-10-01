import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Proofreader Studio",
  description: "Premium Pedagogical AI Proofreading Studio",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-[#FAFAFA] font-sans text-gray-900 antialiased selection:bg-[#E05E3C] selection:text-white">
        {children}
      </body>
    </html>
  );
}
