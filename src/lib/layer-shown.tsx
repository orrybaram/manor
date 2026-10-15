/**
 * Whether the `tab-styles` layer a component sits in is on screen.
 *
 * The layers nest (a workspace's layer holds its panels' tab layers) and a
 * hidden one is still mounted, so being rendered says nothing about being
 * seen. Each layer that can hide wraps its children in {@link ShownLayer}; a
 * component inside is shown only while every layer around it is. Outside any
 * layer, it is shown.
 */

import { createContext, useContext } from "react";

const LayerShownContext = createContext(true);

export function ShownLayer(props: { shown: boolean; children: React.ReactNode }) {
  const parentShown = useContext(LayerShownContext);
  return (
    <LayerShownContext.Provider value={parentShown && props.shown}>
      {props.children}
    </LayerShownContext.Provider>
  );
}

/** True while every layer around the caller is shown. */
export function useLayerShown(): boolean {
  return useContext(LayerShownContext);
}
