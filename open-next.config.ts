// 本应用没有 ISR / 图片优化需求，使用默认（无持久化）增量缓存
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
