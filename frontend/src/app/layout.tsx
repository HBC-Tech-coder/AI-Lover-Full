import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "完美恋人",
  description: "实时语音 AI 陪伴助手",
  manifest: "/manifest.webmanifest",
  applicationName: "完美恋人",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "完美恋人",
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0f172a",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="dark" suppressHydrationWarning>
      {/* suppressHydrationWarning above only quiets attribute-level
          mismatches on this element caused by browser extensions
          (e.g. Immersive Translate injecting data-* attrs before React
          hydrates). Child trees still report real mismatches. */}
      <head>
        {/* Live2D Cubism Core — must load before the Live2D avatar mounts. */}
        <script src="/lib/live2dcubismcore.min.js" async />
        {/* Preload the default avatar (kei) assets so the browser starts
            fetching them in parallel with React hydration instead of
            waiting for AvatarLive2D to mount. Saves ~1-2s on first paint
            of the default model. Other avatars load lazily on selection. */}
        <link
          rel="preload"
          as="fetch"
          crossOrigin="anonymous"
          href="/live2d/kei_vowels_pro/kei_vowels_pro.model3.json"
        />
        <link
          rel="preload"
          as="fetch"
          crossOrigin="anonymous"
          href="/live2d/kei_vowels_pro/kei_vowels_pro.moc3"
        />
        <link
          rel="preload"
          as="image"
          href="/live2d/kei_vowels_pro/kei_vowels_pro.2048/texture_00.png"
        />
      </head>
      <body className={inter.className}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
