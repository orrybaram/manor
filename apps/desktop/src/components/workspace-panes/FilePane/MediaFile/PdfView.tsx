import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import Minus from "lucide-react/dist/esm/icons/minus";
import Plus from "lucide-react/dist/esm/icons/plus";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { useMountEffect } from "../../../../hooks/useMountEffect";
import { useLayerShown } from "../../../../lib/layer-shown-context";
import { Button } from "../../../ui/Button/Button";
import { Tooltip } from "../../../ui/Tooltip/Tooltip";
import type { OpenPdf } from "./pdf-document";
import styles from "./MediaFile.module.css";

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/** The gap kept either side of a page. */
const GUTTER_PX = 16;
/** A resize settling before the pages are drawn again at the new size. */
const REDRAW_DELAY_MS = 150;
/** Pages this far from view are drawn ahead, and dropped past it. */
const DRAW_AHEAD = "100% 0px";
/** No page's bitmap is larger than this; past it, zoom stretches it. */
const MAX_CANVAS_PIXELS = 16_000_000;

/** A PDF's pages down the pane, as wide as it at 100%, each drawn only near view. */
export function PdfView({
  pdf,
  scrollerRef,
}: {
  pdf: OpenPdf;
  scrollerRef: RefObject<HTMLDivElement | null>;
}) {
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(0);
  const [drawnFitWidth, setDrawnFitWidth] = useState(0);

  useMountEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      const width = Math.max(0, scroller.clientWidth - GUTTER_PX * 2);
      setFitWidth(width);
      // The first size draws at once; a later one stretches what is drawn until it settles.
      setDrawnFitWidth((drawn) => (drawn === 0 ? width : drawn));
      clearTimeout(timer);
      timer = setTimeout(() => setDrawnFitWidth(width), REDRAW_DELAY_MS);
    });
    observer.observe(scroller);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  });

  const step = ZOOM_STEPS.indexOf(zoom);
  const pages = Array.from({ length: pdf.doc.numPages }, (_, i) => i + 1);
  return (
    <>
      <div className={styles.pdfBar} data-testid="file-pane-pdf-bar">
        <span data-testid="file-pane-pdf-pages">
          {pages.length} {pages.length === 1 ? "page" : "pages"}
        </span>
        <ZoomButton label="Zoom out" testId="file-pane-pdf-zoom-out" to={ZOOM_STEPS[step - 1]} onZoom={setZoom}>
          <Minus size={12} />
        </ZoomButton>
        <span className={styles.pdfZoom} data-testid="file-pane-pdf-zoom">
          {Math.round(zoom * 100)}%
        </span>
        <ZoomButton label="Zoom in" testId="file-pane-pdf-zoom-in" to={ZOOM_STEPS[step + 1]} onZoom={setZoom}>
          <Plus size={12} />
        </ZoomButton>
      </div>
      <div className={styles.pdfPages} style={{ padding: GUTTER_PX }}>
        {fitWidth > 0 &&
          pages.map((number) => (
            <PdfPage
              key={`${pdf.doc.loadingTask.docId}:${number}`}
              doc={pdf.doc}
              number={number}
              firstAspect={pdf.aspect}
              width={fitWidth * zoom}
              drawnWidth={drawnFitWidth * zoom}
              scrollerRef={scrollerRef}
            />
          ))}
      </div>
    </>
  );
}

function ZoomButton({
  label,
  testId,
  to,
  onZoom,
  children,
}: {
  label: string;
  testId: string;
  /** The zoom it goes to; undefined at the end of the steps. */
  to: number | undefined;
  onZoom: (zoom: number) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <Button
        variant="ghost"
        size="sm"
        className={styles.pdfBarBtn}
        aria-label={label}
        data-testid={testId}
        disabled={to === undefined}
        onClick={() => {
          if (to !== undefined) onZoom(to);
        }}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

function PdfPage({
  doc,
  number,
  firstAspect,
  width,
  drawnWidth,
  scrollerRef,
}: {
  doc: PDFDocumentProxy;
  number: number;
  firstAspect: number;
  /** The width it shows at. */
  width: number;
  /** The width it is drawn for: `width`, once a resize has settled. */
  drawnWidth: number;
  scrollerRef: RefObject<HTMLDivElement | null>;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  // A hidden layer's box stays laid out, so it would still count as near.
  const shown = useLayerShown();
  const drawn = near && shown;
  const [aspect, setAspect] = useState(firstAspect);

  useMountEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry.isIntersecting),
      { root: scrollerRef.current, rootMargin: DRAW_AHEAD },
    );
    observer.observe(holder);
    return () => observer.disconnect();
  });

  // pdf.js draws asynchronously and takes a canvas: an external system, driven
  // by what is on screen. The old canvas stays up until the new one is ready.
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    if (!drawn) {
      if (holder.firstChild) {
        holder.replaceChildren();
        // What pdf.js holds for the page goes with its canvas.
        void doc.getPage(number).then(
          (page) => page.cleanup(),
          () => {},
        );
      }
      return;
    }
    let cancelled = false;
    let task: RenderTask | null = null;
    void (async () => {
      const page = await doc.getPage(number);
      if (cancelled) return;
      const size = page.getViewport({ scale: 1 });
      setAspect(size.width / size.height);
      const viewport = page.getViewport({
        scale: Math.min(
          (drawnWidth * window.devicePixelRatio) / size.width,
          Math.sqrt(MAX_CANVAS_PIXELS / (size.width * size.height)),
        ),
      });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = page.render({ canvas, viewport });
      await task.promise;
      if (!cancelled) holder.replaceChildren(canvas);
    })().catch((err: unknown) => {
      if (cancelled || (err as { name?: unknown } | null)?.name === "RenderingCancelledException") {
        return;
      }
      console.error(`[PdfView] could not draw page ${number}:`, err);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, number, drawn, drawnWidth]);

  return (
    <div
      ref={holderRef}
      className={styles.pdfPage}
      data-testid="file-pane-pdf-page"
      data-page={number}
      style={{ width, height: width / aspect }}
    />
  );
}
