import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";
import { openFileFromPalette, openFromTree, pane, typeAtEnd } from "./helpers/file-pane";
import { gradientPng, jpxPdf, simplePdf } from "./helpers/media-files";

/**
 * The file pane shows an image or a PDF rather than refusing its bytes, and
 * follows it on disk as it does a text file.
 */

const LINES = [
  "An image or a PDF opens in the file pane, read through the host's backend.",
  "It is drawn by pdf.js, page by page, as it comes near view.",
];

const specPdf = (title: string) =>
  simplePdf([
    { width: 612, height: 792, title, lines: LINES },
    { width: 792, height: 612, title: "Page two, landscape", lines: ["Its own shape."] },
  ]);

const byTestId = (window: Page, id: string) => pane(window).locator(`[data-testid="${id}"]`);
const media = (window: Page) => byTestId(window, "file-pane-media");
const image = (window: Page) => byTestId(window, "file-pane-image");
/** How long a change on disk may take to reach the pane. */
const followsDisk = { timeout: 10_000 };
const pdfPage = (window: Page, n: number) =>
  pane(window).locator(`[data-testid="file-pane-pdf-page"][data-page="${n}"]`);

/**
 * The whole page is on the canvas, sharp: its bitmap is the size it shows at,
 * the band across the top is blue, text lies under it (in a font the PDF
 * doesn't embed), and the foot of the page is bare paper.
 */
const drawnWhole = (window: Page, n: number) =>
  pdfPage(window, n)
    .locator("canvas")
    .evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext("2d");
      if (!context) return false;
      const box = canvas.getBoundingClientRect();
      const sharp = Math.abs(canvas.width - box.width * window.devicePixelRatio) <= 2;
      const pixel = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data);
      const [red, , blue] = pixel(2, 2);
      const foot = pixel(canvas.width - 2, canvas.height - 2);
      const under = context.getImageData(
        0,
        Math.floor(canvas.height * 0.14),
        canvas.width,
        Math.floor(canvas.height * 0.26),
      ).data;
      let text = 0;
      for (let i = 0; i < under.length; i += 4) if (under[i] < 100) text++;
      return sharp && blue > red + 50 && text > 100 && foot.slice(0, 3).every((v) => v > 240);
    });

test("the file pane shows images and PDFs and follows them on disk", async ({
  app,
  window,
  tempHome,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  window.on("console", (m) => {
    if (m.type() === "error" || /fake worker/i.test(m.text())) errors.push(m.text());
  });
  window.on("pageerror", (e) => errors.push(e.message));

  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-media");
  const termId = await activePaneId(window);
  await awaitShellReady(window, tempHome, termId);
  await runInTerminal(window, 'pwd > "$HOME/ws-path"');
  await expect.poll(() => fs.existsSync(path.join(tempHome, "ws-path"))).toBe(true);
  const ws = fs.readFileSync(path.join(tempHome, "ws-path"), "utf-8").trim();
  execSync("git init -q", { cwd: ws });
  const write = (name: string, bytes: Buffer | string) =>
    fs.writeFileSync(path.join(ws, name), bytes);
  write("logo.png", gradientPng(640, 400));
  write("wide.png", gradientPng(3000, 300));
  write("spec.pdf", specPdf("Manor spec"));
  write("notes.md", "# Notes\n");
  write("icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
  write("scan.pdf", jpxPdf());
  write("big.pdf", simplePdf([{ width: 612, height: 792, title: "Large", lines: LINES }]));
  // Past a piece's size, with a comment a PDF reader skips: it reads whole in pieces.
  fs.appendFileSync(path.join(ws, "big.pdf"), `%${"x".repeat(4 * 1024 * 1024)}\n`);
  write("fake.png", "not an image at all");
  write("fake.pdf", "not a pdf at all");

  await openFileFromPalette(window);

  // An image: fits, says its size, and a click shows it at its actual size.
  await openFromTree(window, ["logo.png"]);
  await expect(image(window)).toBeVisible();
  await expect(byTestId(window, "file-pane-image-size")).toHaveText("640 × 400");
  await expect(byTestId(window, "file-pane-breadcrumb")).toContainText("logo.png");
  await window.screenshot({ path: testInfo.outputPath("image-dark.png") });

  // An agent rewrites it, twice: the pane follows each.
  write("logo.png", gradientPng(320, 200));
  await expect(byTestId(window, "file-pane-image-size")).toHaveText("320 × 200", followsDisk);
  write("logo.png", gradientPng(160, 100));
  await expect(byTestId(window, "file-pane-image-size")).toHaveText("160 × 100", followsDisk);

  // Too wide for the pane: fits it until clicked, then scrolls.
  await openFromTree(window, ["wide.png"]);
  await expect(image(window)).toBeVisible();
  const fits = await media(window).evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(fits).toBe(true);
  await image(window).click();
  await expect
    .poll(() => media(window).evaluate((el) => el.scrollWidth > el.clientWidth))
    .toBe(true);
  await image(window).click();

  // A PDF: its pages, drawn with ink on them, the second in its own shape.
  await openFromTree(window, ["spec.pdf"]);
  await expect(byTestId(window, "file-pane-pdf-pages")).toHaveText("2 pages");
  await expect(pdfPage(window, 1).locator("canvas")).toBeVisible();
  await expect.poll(() => drawnWhole(window, 1)).toBe(true);
  await window.waitForTimeout(300);
  await window.screenshot({ path: testInfo.outputPath("pdf-dark.png") });
  await pdfPage(window, 2).scrollIntoViewIfNeeded();
  await expect.poll(() => drawnWhole(window, 2)).toBe(true);
  const second = await pdfPage(window, 2).boundingBox();
  expect(second!.width).toBeGreaterThan(second!.height);

  // Zoom draws it larger, and it can be stepped back.
  const before = (await pdfPage(window, 1).boundingBox())!.width;
  await byTestId(window, "file-pane-pdf-zoom-in").click();
  await expect(byTestId(window, "file-pane-pdf-zoom")).toHaveText("125%");
  await expect
    .poll(async () => (await pdfPage(window, 1).boundingBox())!.width)
    .toBeCloseTo(before * 1.25, 0);
  // Redrawn for the new size, not stretched.
  await expect.poll(() => drawnWhole(window, 1)).toBe(true);
  await byTestId(window, "file-pane-pdf-zoom-out").click();

  // Zoomed in, the bar stays in view however far the pages are scrolled.
  await byTestId(window, "file-pane-pdf-zoom-in").click();
  await byTestId(window, "file-pane-pdf-zoom-in").click();
  await media(window).evaluate((el) => el.scrollTo(el.scrollWidth, 300));
  const bar = (await byTestId(window, "file-pane-pdf-bar").boundingBox())!;
  const scroller = (await media(window).boundingBox())!;
  expect(bar.y).toBeLessThan(scroller.y + 20);
  expect(bar.x + bar.width).toBeLessThanOrEqual(scroller.x + scroller.width);
  await byTestId(window, "file-pane-pdf-zoom-out").click();
  await byTestId(window, "file-pane-pdf-zoom-out").click();

  // Rewritten on disk: it follows, and still has ink.
  write(
    "spec.pdf",
    simplePdf([{ width: 612, height: 792, title: "Rewritten", lines: LINES }]),
  );
  await expect(byTestId(window, "file-pane-pdf-pages")).toHaveText("1 page", followsDisk);
  await expect.poll(() => drawnWhole(window, 1)).toBe(true);

  // Caught mid-write, it keeps what it shows, zoom and all, until it reads whole.
  await byTestId(window, "file-pane-pdf-zoom-in").click();
  write("spec.pdf", "%PDF-1.4 half of a file");
  await window.waitForTimeout(2500);
  await expect(byTestId(window, "file-pane-pdf-pages")).toHaveText("1 page");
  await expect(byTestId(window, "file-pane-pdf-zoom")).toHaveText("125%");
  write("spec.pdf", specPdf("Whole again"));
  await expect(byTestId(window, "file-pane-pdf-pages")).toHaveText("2 pages", followsDisk);
  await expect(byTestId(window, "file-pane-pdf-zoom")).toHaveText("125%");

  // Deleted, it says so; back, it shows again.
  fs.rmSync(path.join(ws, "spec.pdf"));
  await expect(byTestId(window, "file-pane-error")).toContainText(
    "spec.pdf does not exist",
    followsDisk,
  );
  write("spec.pdf", specPdf("Back again"));
  await expect(byTestId(window, "file-pane-pdf-pages")).toHaveText("2 pages", followsDisk);

  // A scanned page, stored as JPEG 2000: drawn by the decoder the app ships, not left blank.
  await openFromTree(window, ["scan.pdf"]);
  await expect(pdfPage(window, 1).locator("canvas")).toBeVisible();
  await expect
    .poll(() =>
      pdfPage(window, 1)
        .locator("canvas")
        .evaluate((canvas: HTMLCanvasElement) => {
          const pixel = canvas
            .getContext("2d")!
            .getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
          return pixel[0] > 180 && pixel[1] < 80 && pixel[2] < 80;
        }),
    )
    .toBe(true);

  // Larger than a piece: read whole, a piece at a time.
  await openFromTree(window, ["big.pdf"]);
  await expect(byTestId(window, "file-pane-pdf-pages")).toHaveText("1 page");
  await expect.poll(() => drawnWhole(window, 1)).toBe(true);

  // A name that lies says so, rather than a broken picture or an empty pane.
  await openFromTree(window, ["fake.png"]);
  await expect(byTestId(window, "file-pane-error")).toContainText(
    "fake.png can't be shown as an image",
  );
  await openFromTree(window, ["fake.pdf"]);
  await expect(byTestId(window, "file-pane-error")).toContainText(
    "fake.pdf is not a readable PDF",
  );

  // An SVG is text: it opens in the editor.
  await openFromTree(window, ["icon.svg"]);
  await expect(byTestId(window, "file-pane-editor")).toContainText("<svg");

  // Unsaved edits still ask first, and leave nothing behind once answered.
  await openFromTree(window, ["notes.md"]);
  await typeAtEnd(window, "edited");
  await openFromTree(window, ["logo.png"]);
  await byTestId(window, "file-pane-swap-discard").click();
  await expect(image(window)).toBeVisible();
  await expect(byTestId(window, "file-pane-swap-bar")).toHaveCount(0);
  await expect(window.locator('[data-testid="file-pane-dirty"]')).toHaveCount(0);
  await openFromTree(window, ["notes.md"]);
  await expect(byTestId(window, "file-pane-editor")).toContainText("# Notes");

  // Nothing above fell over, was blocked by the page's CSP, or left pdf.js
  // parsing on the main thread for want of its worker.
  expect(errors.filter((e) => /Content Security Policy|PdfView|pdf\.js|fake worker/i.test(e))).toEqual([]);
});
