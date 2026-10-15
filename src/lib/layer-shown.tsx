import { useContext } from "react";
import { LayerShownContext } from "./layer-shown-context";

/** A layer that can hide: its children are shown only while it and its parents are. */
export function ShownLayer(props: { shown: boolean; children: React.ReactNode }) {
  const parentShown = useContext(LayerShownContext);
  return (
    <LayerShownContext.Provider value={parentShown && props.shown}>
      {props.children}
    </LayerShownContext.Provider>
  );
}
