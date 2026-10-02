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
 * An image embedded in a task body. Linear's uploads need the auth'd main
 * process to fetch them (`linear.proxyImage`, falling back to the raw URL);
 * GitHub's render directly. Hidden if it fails to load. Key by `url`.
 */
export function ProxiedImage(props: ProxiedImageProps) {
  const { provider, url, alt } = props;

  const [failed, setFailed] = useState(false);
  const proxied = useQuery({
    queryKey: ["task-image", url],
    queryFn: () =>
      window.electronAPI.linear.proxyImage(url).catch(() => url),
    enabled: provider === "linear",
    staleTime: Infinity,
  });

  const src = provider === "linear" ? proxied.data : url;
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
