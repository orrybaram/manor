import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";

/**
 * Footnote ids and hrefs are generated unprefixed (`clobberPrefix: ""`) and
 * the sanitiser then prefixes ids (not hrefs) with `user-content-` exactly
 * once, so a footnote href is `#<id>` and its target is `user-content-<id>`.
 * Headings get their slug as an id the same way, so `[Setup](#setup)` lands.
 */
export const gfmPipeline = {
  remarkPlugins: [remarkGfm],
  remarkRehypeOptions: { clobberPrefix: "" },
  rehypePlugins: [rehypeRaw, rehypeSlug, rehypeSanitize],
};
