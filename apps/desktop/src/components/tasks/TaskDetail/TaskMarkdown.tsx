import type { TaskProvider } from "../../../lib/tasks";
import { GfmMarkdown } from "../../ui/GfmMarkdown/GfmMarkdown";
import { ProxiedImage } from "./ProxiedImage";

type TaskMarkdownProps = {
  provider: TaskProvider;
  source: string;
  /** The task's URL, which relative links in its body resolve against. */
  baseUrl: string;
};

/**
 * A task body as GitHub-flavoured markdown, with images loaded through the
 * tracker's auth'd proxy so a private repo's screenshots render in place.
 */
export default function TaskMarkdown(props: TaskMarkdownProps) {
  const { provider, source, baseUrl } = props;

  return (
    <GfmMarkdown
      source={source}
      baseUrl={baseUrl}
      renderImage={(image) => (
        <ProxiedImage key={image.src} provider={provider} {...image} />
      )}
    />
  );
}
