import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";

/**
 * Footnote ids and hrefs are generated unprefixed (`clobberPrefix: ""`) and
 * the sanitiser then prefixes ids (not hrefs) with `user-content-` exactly
 * once, so a footnote href is `#<id>` and its target is `user-content-<id>`.
 */
export const gfmPipeline = {
  remarkPlugins: [remarkGfm],
  remarkRehypeOptions: { clobberPrefix: "" },
  rehypePlugins: [rehypeRaw, rehypeSanitize],
};
