import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TaskProvider } from "../../../lib/tasks";
import styles from "./TaskDetail.module.css";

type ProxiedImageProps = {
  provider: TaskProvider;
  url: string;
  alt?: string;
};

/**
 * An image embedded in a task body, fetched by the main process with the
 * tracker's credential (`linear.proxyImage` / `github.proxyImage`) so a
 * private upload renders; falls back to the raw URL when the proxy declines
 * (a non-tracker host) or fails. Hidden if it fails to load. Key by `url`.
 */
export function ProxiedImage(props: ProxiedImageProps) {
  const { provider, url, alt } = props;

  const [failed, setFailed] = useState(false);
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
    staleTime: Infinity,
  });

  const src = proxied.data;
  if (!src || failed) return null;

  return (
    <img
      src={src}
      alt={alt || "Screenshot"}
      className={styles.screenshot}
      onError={() => setFailed(true)}
    />
  );
}
