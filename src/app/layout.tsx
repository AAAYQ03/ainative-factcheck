import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "投顾稿件核查台",
  description: "AI 辅助的投顾内容事实核查与合规审查：每个结论都能追溯到扶摇数据源原始字段",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
