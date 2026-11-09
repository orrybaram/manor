import { useState } from "react";
import styles from "./MediaFile.module.css";

/**
 * An image, shrunk to fit the pane; a click toggles its actual size. Its size
 * sits in the corner. `onFail`: its bytes aren't the image its name says.
 */
export function ImageView({
  src,
  path,
  onFail,
}: {
  src: string;
  path: string;
  onFail: () => void;
}) {
  const [actualSize, setActualSize] = useState(false);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  return (
    <>
      <img
        src={src}
        alt={path}
        className={actualSize ? styles.imageActual : styles.imageFit}
        data-testid="file-pane-image"
        onClick={() => setActualSize(!actualSize)}
        onLoad={(e) =>
          setNatural({
            width: e.currentTarget.naturalWidth,
            height: e.currentTarget.naturalHeight,
          })
        }
        onError={onFail}
      />
      {natural && (
        <span className={styles.imageSize} data-testid="file-pane-image-size">
          {natural.width} × {natural.height}
        </span>
      )}
    </>
  );
}
