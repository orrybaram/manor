/** Add a slide: import it and list it here. Its place comes from `SLIDE_ORDER`. */
import { SLIDE_ORDER, type Slide } from "../slide";
import { sideBySide } from "./side-by-side";

const BUILT: readonly Slide[] = [sideBySide];

export const SLIDES: readonly Slide[] = SLIDE_ORDER.flatMap((id) => BUILT.find((slide) => slide.id === id) ?? []);
