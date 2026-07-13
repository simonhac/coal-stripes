import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/react";
import { Providers } from "./providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Coal Availability",
  description: "Australian coal power plant capacity factor visualisation",
  icons: {
    icon: '/favicon.svg',
  },
  metadataBase: new URL('https://stripes.energy'),
  openGraph: {
    title: 'Coal Availability',
    description: 'Real-time visualisation of Australian coal power plant capacity factors',
    url: 'https://stripes.energy',
    siteName: 'Coal Stripes',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 516,
        alt: 'Australian coal power plant availability stripes visualisation',
      }
    ],
    locale: 'en_AU',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Coal Availability',
    description: 'Real-time visualisation of Australian coal power plant capacity factors',
    images: ['/og-image.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Providers>{children}</Providers>
        <SpeedInsights />
        <Analytics />
      </body>
    </html>
  );
}
