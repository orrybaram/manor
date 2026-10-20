/**
 * Whether the `tab-styles` layer a component sits in is on screen.
 *
 * The layers nest (a workspace's layer holds its panels' tab layers) and a
 * hidden one is still mounted, so being rendered says nothing about being
 * seen. Each layer that can hide wraps its children in `ShownLayer`
 * (`layer-shown.tsx`); a component inside is shown only while every layer
 * around it is. Outside any layer, it is shown.
 */

import { createContext, useContext } from "react";

export const LayerShownContext = createContext(true);

/** True while every layer around the caller is shown. */
export function useLayerShown(): boolean {
  return useContext(LayerShownContext);
}
