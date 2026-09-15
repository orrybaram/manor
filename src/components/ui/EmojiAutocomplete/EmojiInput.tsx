import React, { useCallback, useRef } from "react";
import { Input } from "../Input/Input";
import { assignRefs, composeHandlers } from "./compose";
import { useEmojiAutocomplete } from "./useEmojiAutocomplete";

type EmojiInputProps = React.ComponentPropsWithoutRef<typeof Input>;

/**
 * `ui/Input` with `:shortcode` emoji autocomplete (ADR-174). Same props and
 * ref as `Input`; the caller's `onChange` fires for inserted emoji too.
 */
export const EmojiInput = React.forwardRef<HTMLInputElement, EmojiInputProps>(
  (props, forwardedRef) => {
    const { onKeyDown, onInput, onSelect, onBlur, ...rest } = props;

    const innerRef = useRef<HTMLInputElement>(null);
    const { handleKeyDown, fieldProps, suggestions } =
      useEmojiAutocomplete(innerRef);
    const ref = useCallback(
      (node: HTMLInputElement | null) => assignRefs(node, innerRef, forwardedRef),
      [forwardedRef],
    );

    return (
      <>
        <Input
          {...rest}
          {...fieldProps}
          ref={ref}
          onKeyDown={(e) => {
            if (handleKeyDown(e)) return;
            onKeyDown?.(e);
          }}
          onInput={composeHandlers(fieldProps.onInput, onInput)}
          onSelect={composeHandlers(fieldProps.onSelect, onSelect)}
          onBlur={composeHandlers(fieldProps.onBlur, onBlur)}
        />
        {suggestions}
      </>
    );
  },
);

EmojiInput.displayName = "EmojiInput";
