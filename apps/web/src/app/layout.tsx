import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "BrandAI · 品牌视觉 AI",
  description: "以项目为中心,基于品牌套件批量生成符合规范的商业视觉内容",
};

/**
 * P3.1: Multi-skin support.
 *
 * Build-time default (NEXT_PUBLIC_UI_EDITORIAL=dark) sets the initial class on
 * the server. The inline pre-paint script below then overrides from
 * localStorage (key: brandai-theme) before the first paint, so user
 * preference wins without FOUC. Recognized values: light | dark | theme-mono
 * | theme-tech. See packages/ui/src/styles.css for the token blocks.
 */
const editorialTheme = process.env.NEXT_PUBLIC_UI_EDITORIAL ?? "light";

const THEME_INIT_SCRIPT = `
(function(){
  try {
    var classes = ['dark','theme-mono','theme-tech'];
    var html = document.documentElement;
    var t = localStorage.getItem('brandai-theme');
    if (t === 'light' || (t && classes.indexOf(t) >= 0)) {
      classes.forEach(function(c){ html.classList.remove(c); });
      if (t !== 'light') html.classList.add(t);
    }
  } catch(e) {}
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const htmlClass = editorialTheme === "dark" ? "dark" : undefined;
  return (
    <html lang="zh-CN" className={htmlClass} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
