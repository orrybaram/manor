import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TaskProvider } from "../../../lib/tasks";
import { trackerFor } from "../../../lib/trackers";
import type { GfmImage } from "../../ui/GfmMarkdown/GfmMarkdown";
import styles from "./TaskDetail.module.css";

type ProxiedImageProps = GfmImage & {
  provider: TaskProvider;
};

/**
 * An image embedded in a task body. One on the tracker's own host is fetched
 * by the main process with the tracker's credential (`TaskTracker.imageQuery`)
 * so a private upload renders, falling back to the raw URL if that fails; any
 * other host loads straight from its URL. Hidden if it fails to load. Key by
 * `src`.
 */
export function ProxiedImage(props: ProxiedImageProps) {
  const { provider, src: url, alt, width, height } = props;

  const [failed, setFailed] = useState(false);
  const query = trackerFor(provider).imageQuery(url);
  const proxied = useQuery({
    queryKey: query?.queryKey ?? ["task-image", provider, url],
    queryFn: async () => {
      if (!query) return url;
      try {
        return await query.queryFn();
      } catch {
        return url;
      }
    },
    enabled: query !== null,
    staleTime: query?.staleTime ?? Infinity,
  });

  const src = query ? proxied.data : url;
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
