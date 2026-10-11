import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isTrackerImageUrl } from "../../../lib/task-images";
import type { TaskProvider } from "../../../lib/tasks";
import type { GfmImage } from "../../ui/GfmMarkdown/GfmMarkdown";
import styles from "./TaskDetail.module.css";

type ProxiedImageProps = GfmImage & {
  provider: TaskProvider;
};

/**
 * An image embedded in a task body. One on the tracker's own host is fetched
 * by the main process with the tracker's credential (`linear.proxyImage` /
 * `github.proxyImage`) so a private upload renders, falling back to the raw
 * URL if that fails; any other host loads straight from its URL. Hidden if
 * it fails to load. Key by `src`.
 */
export function ProxiedImage(props: ProxiedImageProps) {
  const { provider, src: url, alt, width, height } = props;

  const [failed, setFailed] = useState(false);
  const proxy = isTrackerImageUrl(provider, url);
  const proxied = useQuery({
    queryKey: ["task-image", provider, url],
    queryFn: async () => {
      try {
        const api = window.electronAPI;
        return provider === "linear"
          ? await api.linear.proxyImage(url)
          : await api.github.proxyImage(url);
      } catch {
        return url;
      }
    },
    enabled: proxy,
    staleTime: Infinity,
  });

  const src = proxy ? proxied.data : url;
  if (!src || failed) return null;

  return (
    <img
      src={src}
      alt={alt || "Screenshot"}
      width={width}
      height={height}
      className={styles.screenshot}
      onError={() => setFailed(true)}
    />
  );
}
